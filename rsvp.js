(function () {
  'use strict';

  // TEMP: skip the invitation-code gate while designing the site.
  // Set back to false before sharing / launch.
  const BYPASS_INVITE_CODE = false;
  const SESSION_CODE_KEY = 'shawn-lizzy-rsvp-code';

  // Fake party used only when BYPASS_INVITE_CODE is on, so the RSVP UI is visible.
  const DEMO_INVITATION = {
    reserved_seats: 2,
    submitted: false,
    closed: false,
    deadline: '2026-09-14',
    guests: [
      {
        seat_number: 1,
        name: '',
        attending: null,
        dietary_requirements: ''
      },
      {
        seat_number: 2,
        name: '',
        attending: null,
        dietary_requirements: ''
      }
    ]
  };

  const config = window.WEDDING_CONFIG || {};
  const state = { code: '', invitation: null, pendingResponses: null };

  const elements = {
    gate: document.getElementById('access-gate'),
    site: document.getElementById('site-content'),
    replayIntro: document.getElementById('replay-intro'),
    login: document.getElementById('rsvp-login'),
    codeInput: document.getElementById('rsvp-password'),
    lookupButton: document.getElementById('rsvp-lookup-button'),
    lookupError: document.getElementById('rsvp-error'),
    seatCopy: document.getElementById('rsvp-seat-copy'),
    form: document.getElementById('rsvp-form'),
    submittedBanner: document.getElementById('rsvp-submitted-banner'),
    closed: document.getElementById('rsvp-closed'),
    partyAttendance: document.getElementById('party-attendance'),
    guestRows: document.getElementById('guest-rows'),
    formError: document.getElementById('rsvp-form-error'),
    reviewButton: document.getElementById('rsvp-review-button'),
    useAnother: document.getElementById('rsvp-use-another'),
    review: document.getElementById('rsvp-review'),
    reviewHeading: document.getElementById('rsvp-review-heading'),
    reviewList: document.getElementById('rsvp-review-list'),
    submitError: document.getElementById('rsvp-submit-error'),
    backButton: document.getElementById('rsvp-back-button'),
    submitButton: document.getElementById('rsvp-submit-button'),
    success: document.getElementById('rsvp-success'),
    successMessage: document.getElementById('rsvp-success-message'),
    editButton: document.getElementById('rsvp-edit-button'),
    successAnother: document.getElementById('rsvp-success-another'),
    deadlineHeading: document.getElementById('rsvp-deadline-heading')
  };
  const defaultDeadlineText = elements.deadlineHeading.textContent;

  class RsvpApiError extends Error {
    constructor(message, code, retryAfterSeconds) {
      super(message);
      this.code = code;
      this.retryAfterSeconds = retryAfterSeconds || 0;
    }
  }

  async function callRsvpApi(action, payload) {
    if (!config.rsvpEndpoint) {
      throw new RsvpApiError('RSVP configuration is missing.', 'CONFIG');
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(config.rsvpEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action, ...payload }),
        signal: controller.signal
      });

      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const retryAfter = Number(
          body && body.retry_after_seconds
            ? body.retry_after_seconds
            : response.headers.get('Retry-After')
        );
        throw new RsvpApiError(
          body && body.message ? body.message : 'Request failed.',
          body && body.code,
          Number.isFinite(retryAfter) ? retryAfter : 0
        );
      }
      return body;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new RsvpApiError('The request timed out.', 'NETWORK');
      }
      if (error instanceof RsvpApiError) throw error;
      throw new RsvpApiError('Could not reach the RSVP service.', 'NETWORK');
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function retryWaitText(seconds) {
    if (!seconds || seconds < 60) return 'a minute';
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  function showError(element, message) {
    element.textContent = message;
    element.classList.add('visible');
  }

  function clearError(element) {
    element.textContent = '';
    element.classList.remove('visible');
  }

  function savedSessionCode() {
    try {
      return window.sessionStorage.getItem(SESSION_CODE_KEY) || '';
    } catch {
      return '';
    }
  }

  function saveSessionCode(code) {
    try {
      window.sessionStorage.setItem(SESSION_CODE_KEY, code);
    } catch {
      // The invitation still works when browser storage is unavailable.
    }
  }

  function clearSessionCode() {
    try {
      window.sessionStorage.removeItem(SESSION_CODE_KEY);
    } catch {
      // Nothing else is needed when browser storage is unavailable.
    }
  }

  function setButtonBusy(button, busy, busyText, normalText) {
    button.disabled = busy;
    button.textContent = busy ? busyText : normalText;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function lookupErrorMessage(error) {
    if (error.code === 'CONFIG') {
      return 'Invitation access is not configured yet. Please contact the couple for help.';
    }
    if (error.code === 'RATE_LIMITED') {
      return `For everyone’s privacy, too many invitation codes have been tried from this connection. Please wait ${retryWaitText(error.retryAfterSeconds)} and try again.`;
    }
    return 'We could not check that code right now. Check your connection and try again.';
  }

  function submitErrorMessage(error) {
    if (error.code === 'RATE_LIMITED') {
      return `For everyone’s privacy, RSVP saving is temporarily limited from this connection. Please wait ${retryWaitText(error.retryAfterSeconds)} and try again; your responses are still shown here.`;
    }
    if (error.code === 'RSVP_NOT_SAVED') {
      return 'We could not save this RSVP. Please review every reserved seat and try again, or return and re-enter the invitation code.';
    }
    return 'We could not save your RSVP. Check your connection and try again; your responses are still shown here.';
  }

  function formatDeadline(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'long',
      timeZone: 'Asia/Manila'
    }).format(date);
  }

  function updateDeadline(invitation) {
    const deadline = formatDeadline(invitation.deadline);
    elements.deadlineHeading.textContent = deadline || defaultDeadlineText;
  }

  function hasValidInvitationSeats(invitation) {
    return invitation
      && Number.isInteger(invitation.reserved_seats)
      && invitation.reserved_seats >= 1
      && invitation.reserved_seats <= 50
      && Array.isArray(invitation.guests)
      && invitation.guests.length === invitation.reserved_seats
      && invitation.guests.every((guest, index) => (
        guest
        && Number.isInteger(guest.seat_number)
        && guest.seat_number === index + 1
      ));
  }

  function seatReservationText(invitation) {
    const seatWord = invitation.reserved_seats === 1 ? 'seat' : 'seats';
    return `We reserved ${invitation.reserved_seats} ${seatWord} for you.`;
  }

  function startContentCascade() {
    if (document.body.classList.contains('site-content-live')) return;
    window.requestAnimationFrame(() => {
      document.body.classList.add('site-content-live');
    });
  }

  function unlockSite() {
    elements.gate.hidden = true;
    elements.site.hidden = false;
    elements.site.removeAttribute('inert');
    elements.site.setAttribute('aria-hidden', 'false');
    document.body.classList.remove('site-locked');
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    startContentCascade();

    elements.site.setAttribute('tabindex', '-1');
    elements.site.focus({ preventScroll: true });
    elements.site.removeAttribute('tabindex');
  }

  function playEnvelopeIntro() {
    elements.gate.hidden = true;
    elements.site.hidden = false;
    elements.site.setAttribute('inert', '');
    elements.site.setAttribute('aria-hidden', 'true');
    document.body.classList.add('site-locked');
    document.body.classList.remove('site-content-live');
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });

    if (window.WeddingEnvelope) {
      window.WeddingEnvelope.play(unlockSite);
    } else {
      unlockSite();
    }
  }

  function lockSite() {
    if (window.WeddingEnvelope) window.WeddingEnvelope.cancel();
    elements.site.setAttribute('inert', '');
    elements.site.setAttribute('aria-hidden', 'true');
    elements.site.hidden = true;
    elements.gate.hidden = false;
    document.body.classList.add('site-locked');
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }

  function renderInvitation(invitation, options = {}) {
    const unlockingSite = elements.site.hidden;
    state.invitation = invitation;
    state.pendingResponses = null;

    elements.login.hidden = true;
    elements.review.hidden = true;
    elements.success.hidden = true;
    elements.form.hidden = false;
    elements.submittedBanner.hidden = !invitation.submitted;
    elements.closed.hidden = !invitation.closed;
    elements.partyAttendance.hidden = invitation.reserved_seats < 2 || invitation.closed;
    elements.reviewButton.hidden = invitation.closed;
    elements.seatCopy.textContent = seatReservationText(invitation);
    clearError(elements.formError);
    updateDeadline(invitation);
    renderGuests(invitation);

    if (invitation.closed) {
      elements.guestRows.querySelectorAll('input').forEach((input) => { input.disabled = true; });
    }

    if (unlockingSite) {
      if (options.skipIntro) {
        unlockSite();
      } else {
        playEnvelopeIntro();
      }
    } else if (options.scroll !== false) {
      elements.form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      elements.form.setAttribute('tabindex', '-1');
      elements.form.focus({ preventScroll: true });
      elements.form.removeAttribute('tabindex');
    }
  }

  function makeLabel(text, input) {
    const label = document.createElement('label');
    label.className = 'attendance-choice';
    label.append(input, document.createTextNode(text));
    return label;
  }

  function renderGuests(invitation) {
    elements.guestRows.replaceChildren();

    invitation.guests.forEach((guest, index) => {
      const card = document.createElement('fieldset');
      card.className = 'guest-row';
      card.dataset.seatNumber = String(guest.seat_number);

      const legend = document.createElement('legend');
      legend.className = 'guest-row-header';
      legend.textContent = `Reserved seat ${index + 1}`;

      const nameGroup = document.createElement('div');
      nameGroup.className = 'form-group';
      const nameLabel = document.createElement('label');
      nameLabel.className = 'form-label';
      nameLabel.htmlFor = `guest-name-${guest.seat_number}`;
      nameLabel.textContent = 'Guest name';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.id = `guest-name-${guest.seat_number}`;
      nameInput.className = 'form-input guest-name';
      nameInput.value = guest.name || '';
      nameInput.placeholder = 'Enter guest name';
      nameInput.maxLength = 200;
      nameInput.autocomplete = 'name';
      nameGroup.append(nameLabel, nameInput);

      const attendance = document.createElement('fieldset');
      attendance.className = 'attendance-group';
      const attendanceLegend = document.createElement('legend');
      attendanceLegend.className = 'form-label';
      attendanceLegend.textContent = 'Will this guest attend?';
      const options = document.createElement('div');
      options.className = 'attendance-options';

      const yes = document.createElement('input');
      yes.type = 'radio';
      yes.name = `guest-attending-${guest.seat_number}`;
      yes.value = 'true';
      yes.checked = guest.attending === true;
      yes.setAttribute('aria-label', 'Attending');

      const no = document.createElement('input');
      no.type = 'radio';
      no.name = `guest-attending-${guest.seat_number}`;
      no.value = 'false';
      no.checked = guest.attending === false;
      no.setAttribute('aria-label', 'Not attending');

      options.append(makeLabel('Attending', yes), makeLabel('Not attending', no));
      attendance.append(attendanceLegend, options);

      const dietaryGroup = document.createElement('div');
      dietaryGroup.className = 'guest-dietary';
      dietaryGroup.hidden = guest.attending !== true;
      const dietaryLabel = document.createElement('label');
      dietaryLabel.className = 'form-label';
      dietaryLabel.htmlFor = `guest-diet-${guest.seat_number}`;
      dietaryLabel.textContent = 'Dietary requirements';
      const dietaryInput = document.createElement('input');
      dietaryInput.type = 'text';
      dietaryInput.id = `guest-diet-${guest.seat_number}`;
      dietaryInput.className = 'form-input guest-diet';
      dietaryInput.value = guest.dietary_requirements || '';
      dietaryInput.placeholder = 'Allergies, preferences, or none';
      dietaryInput.maxLength = 1000;
      dietaryInput.disabled = guest.attending !== true;
      dietaryGroup.append(dietaryLabel, dietaryInput);

      options.addEventListener('change', () => {
        const attending = yes.checked;
        dietaryGroup.hidden = !attending;
        dietaryInput.disabled = !attending;
        if (!attending) dietaryInput.value = '';
        card.classList.remove('has-error');
        updatePartyAttendanceChoice();
      });
      nameInput.addEventListener('input', () => card.classList.remove('has-error'));

      card.append(legend, nameGroup, attendance, dietaryGroup);
      elements.guestRows.append(card);
    });

    updatePartyAttendanceChoice();
  }

  function guestCards() {
    return Array.from(elements.guestRows.querySelectorAll('.guest-row'));
  }

  function setAllAttendance(attending) {
    guestCards().forEach((card) => {
      const input = card.querySelector(`input[type="radio"][value="${attending}"]`);
      if (input && !input.disabled) {
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }

  function updatePartyAttendanceChoice() {
    const choices = guestCards().map((card) => {
      const selected = card.querySelector('input[type="radio"]:checked');
      return selected ? selected.value : null;
    });
    const value = choices.length && choices.every((choice) => choice === 'true')
      ? 'all'
      : choices.length && choices.every((choice) => choice === 'false')
        ? 'none'
        : 'individual';
    const input = elements.partyAttendance.querySelector(`input[value="${value}"]`);
    if (input) input.checked = true;
  }

  function collectResponses() {
    const allowedSeats = state.invitation && state.invitation.reserved_seats;
    const cards = guestCards();
    if (!Number.isInteger(allowedSeats)
      || cards.length !== allowedSeats
      || cards.length > allowedSeats) {
      showError(elements.formError, 'The reserved guest slots changed unexpectedly. Please re-enter your invitation code.');
      return null;
    }

    let firstInvalid = null;
    const responses = cards.map((card) => {
      card.classList.remove('has-error');
      const selected = card.querySelector('input[type="radio"]:checked');
      const nameInput = card.querySelector('.guest-name');
      const dietaryInput = card.querySelector('.guest-diet');
      const attending = selected ? selected.value === 'true' : null;
      const name = nameInput.value.trim();

      if (attending === null || !name) {
        card.classList.add('has-error');
        if (!firstInvalid) {
          firstInvalid = attending === null
            ? card.querySelector('input[type="radio"]')
            : nameInput;
        }
      }

      return {
        seat_number: Number(card.dataset.seatNumber),
        name,
        attending,
        dietary_requirements: attending ? dietaryInput.value.trim() : ''
      };
    });

    const seatNumbers = responses.map((response) => response.seat_number);
    const seatsAreExact = seatNumbers.every((seatNumber, index) => seatNumber === index + 1)
      && new Set(seatNumbers).size === allowedSeats;
    if (responses.length !== allowedSeats || responses.length > allowedSeats || !seatsAreExact) {
      showError(elements.formError, 'The reserved guest slots changed unexpectedly. Please re-enter your invitation code.');
      return null;
    }

    if (firstInvalid) {
      showError(
        elements.formError,
        'Please choose attending or not attending for every seat, and add a name for each reserved seat.'
      );
      firstInvalid.focus({ preventScroll: true });
      return null;
    }

    clearError(elements.formError);
    return responses;
  }

  function showReview() {
    const responses = collectResponses();
    if (!responses) return;

    state.pendingResponses = responses;
    elements.reviewHeading.textContent = 'Review your party’s response.';
    elements.reviewList.replaceChildren();

    responses.forEach((response, index) => {
      const item = document.createElement('div');
      item.className = 'review-item';
      const name = document.createElement('strong');
      name.textContent = response.name || `Reserved seat ${index + 1}`;
      const attendance = document.createElement('p');
      attendance.textContent = response.attending ? 'Attending' : 'Not attending';
      item.append(name, attendance);
      if (response.attending) {
        const dietary = document.createElement('p');
        dietary.textContent = `Dietary requirements: ${response.dietary_requirements || 'None provided'}`;
        item.append(dietary);
      }
      elements.reviewList.append(item);
    });

    clearError(elements.submitError);
    elements.form.hidden = true;
    elements.review.hidden = false;
    elements.reviewHeading.setAttribute('tabindex', '-1');
    elements.reviewHeading.focus({ preventScroll: true });
  }

  async function submitRsvp() {
    if (!state.pendingResponses) return;
    clearError(elements.submitError);
    setButtonBusy(elements.submitButton, true, 'Saving…', 'Submit RSVP');

    try {
      const invitation = await callRsvpApi('submit', {
        code: state.code,
        responses: state.pendingResponses
      });
      state.invitation = invitation;
      elements.review.hidden = true;
      elements.success.hidden = false;
      elements.successMessage.textContent = 'Thank you. Your party’s response has been saved. You can return with the same code to review or update it before the deadline.';
      elements.editButton.hidden = invitation.closed;
      elements.success.focus({ preventScroll: true });
    } catch (error) {
      showError(elements.submitError, submitErrorMessage(error));
    } finally {
      setButtonBusy(elements.submitButton, false, 'Saving…', 'Submit RSVP');
    }
  }

  function resetToLogin() {
    state.code = '';
    state.invitation = null;
    state.pendingResponses = null;
    clearSessionCode();
    elements.form.hidden = true;
    elements.review.hidden = true;
    elements.success.hidden = true;
    elements.login.hidden = false;
    elements.codeInput.value = '';
    updateDeadline({ deadline: null });
    clearError(elements.lookupError);
    lockSite();
    elements.codeInput.focus();
  }

  elements.login.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError(elements.lookupError);
    const code = elements.codeInput.value.trim();
    if (!code) {
      showError(elements.lookupError, 'Enter the invitation code printed on your invitation.');
      elements.codeInput.focus();
      return;
    }

    setButtonBusy(elements.lookupButton, true, 'Checking…', 'Enter website');
    try {
      const invitation = await callRsvpApi('lookup', { code });
      if (!invitation) {
        showError(elements.lookupError, 'That code does not match our records. Double-check the invitation and try again.');
        elements.codeInput.focus();
        return;
      }
      if (!hasValidInvitationSeats(invitation)) {
        throw new RsvpApiError('Invitation seats are incomplete.', 'DATA');
      }
      state.code = code;
      saveSessionCode(code);
      renderInvitation(invitation);
    } catch (error) {
      showError(elements.lookupError, lookupErrorMessage(error));
      elements.codeInput.focus();
    } finally {
      setButtonBusy(elements.lookupButton, false, 'Checking…', 'Enter website');
    }
  });

  elements.partyAttendance.addEventListener('change', (event) => {
    if (event.target.value === 'all') setAllAttendance('true');
    if (event.target.value === 'none') setAllAttendance('false');
  });
  elements.reviewButton.addEventListener('click', showReview);
  elements.backButton.addEventListener('click', () => {
    elements.review.hidden = true;
    elements.form.hidden = false;
  });
  elements.submitButton.addEventListener('click', submitRsvp);
  elements.editButton.addEventListener('click', () => {
    renderInvitation(state.invitation, { scroll: false });
  });
  elements.useAnother.addEventListener('click', resetToLogin);
  elements.successAnother.addEventListener('click', resetToLogin);
  elements.replayIntro.addEventListener('click', playEnvelopeIntro);

  window.addEventListener('offline', () => {
    if (!elements.login.hidden) {
      showError(elements.lookupError, 'You appear to be offline. Reconnect to verify your invitation code.');
    }
  });

  async function restoreSession() {
    const code = savedSessionCode();
    if (!code) return;

    elements.codeInput.disabled = true;
    setButtonBusy(elements.lookupButton, true, 'Opening…', 'Enter website');

    try {
      const invitation = await callRsvpApi('lookup', { code });
      if (!invitation || !hasValidInvitationSeats(invitation)) {
        clearSessionCode();
        return;
      }
      state.code = code;
      renderInvitation(invitation, { scroll: false, skipIntro: true });
    } catch {
      // Keep the session value for a later retry if the network is unavailable.
    } finally {
      elements.codeInput.disabled = false;
      setButtonBusy(elements.lookupButton, false, 'Opening…', 'Enter website');
    }
  }

  if (BYPASS_INVITE_CODE) {
    unlockSite();
    elements.replayIntro.hidden = false;
    renderInvitation(DEMO_INVITATION, { scroll: false });
  } else {
    restoreSession();
  }
})();

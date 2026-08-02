(function () {
  'use strict';

  const elements = {
    overlay: document.getElementById('env-overlay'),
    scene: document.getElementById('env-trigger'),
    flap: document.getElementById('env-flap'),
    seal: document.getElementById('env-seal'),
    letter: document.getElementById('env-letter'),
    body: document.getElementById('env-body'),
    prompt: document.getElementById('env-prompt'),
    holdStatus: document.getElementById('env-hold-status'),
    skip: document.getElementById('skip-intro'),
    replay: document.getElementById('replay-intro'),
    heroQuote: document.querySelector('.hero-quote'),
    heroLogo: document.querySelector('.hero-logo')
  };

  const HOLD_DURATION_MS = 20 * 1000;
  const COUNTDOWN_SECONDS = 10;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let phase = 'idle';
  let runId = 0;
  let timers = new Set();
  let completionCallback = null;
  let holdDeadline = 0;

  function clearTimers() {
    runId += 1;
    timers.forEach((timer) => window.clearTimeout(timer));
    timers = new Set();
  }

  function later(callback, delay) {
    const scheduledRun = runId;
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      if (scheduledRun === runId) callback();
    }, delay);
    timers.add(timer);
  }

  function resetEnvelope() {
    elements.overlay.classList.remove('fade-out', 'morphing');
    elements.flap.classList.remove('open');
    elements.seal.classList.remove('cracking');
    elements.letter.classList.remove('rising', 'flight', 'expanded');
    elements.letter.removeAttribute('style');
    elements.body.classList.remove('hidden');
    elements.prompt.classList.remove('visible');
    elements.holdStatus.hidden = true;
    elements.holdStatus.textContent = '';
    elements.scene.classList.remove('pulsing');
    elements.scene.setAttribute('aria-disabled', 'false');
    elements.scene.setAttribute('tabindex', '0');
    document.body.classList.remove('envelope-holding');

    // Force the entrance animation to restart when a guest chooses replay.
    elements.scene.style.transform = '';
    elements.scene.style.animation = 'none';
    void elements.scene.offsetWidth;
    elements.scene.style.animation = '';
  }

  function complete() {
    if (phase === 'idle') return;
    const callback = completionCallback;
    completionCallback = null;
    clearTimers();
    phase = 'idle';
    elements.overlay.hidden = true;
    elements.overlay.setAttribute('aria-hidden', 'true');
    elements.replay.hidden = false;
    document.body.classList.remove('envelope-active', 'envelope-holding');
    if (callback) callback();
  }

  function skip() {
    if (phase === 'idle') return;
    clearTimers();
    phase = 'closing';
    elements.scene.setAttribute('aria-disabled', 'true');
    elements.scene.setAttribute('tabindex', '-1');
    elements.skip.hidden = true;
    elements.holdStatus.hidden = true;
    elements.overlay.classList.add('fade-out');
    later(complete, reducedMotion.matches ? 160 : 460);
  }

  function expandedTargetRect() {
    const quoteRect = elements.heroQuote.getBoundingClientRect();
    const logoRect = elements.heroLogo.getBoundingClientRect();
    return {
      left: logoRect.left,
      top: quoteRect.top,
      width: logoRect.width
    };
  }

  function updateCountdown() {
    if (phase !== 'holding') return;
    const secondsRemaining = Math.max(0, Math.ceil((holdDeadline - Date.now()) / 1000));
    if (secondsRemaining < 1) return;
    elements.holdStatus.textContent = `Closing in ${secondsRemaining} second${secondsRemaining === 1 ? '' : 's'} · Click to continue`;
    later(updateCountdown, 1000);
  }

  function alignExpandedLetter() {
    const targetRect = expandedTargetRect();
    elements.letter.style.transition = [
      'left 280ms ease',
      'top 280ms ease',
      'width 280ms ease'
    ].join(', ');
    elements.letter.style.left = `${targetRect.left}px`;
    elements.letter.style.top = `${targetRect.top}px`;
    elements.letter.style.width = `${targetRect.width}px`;
  }

  function beginHold() {
    if (phase !== 'expanding') return;
    phase = 'holding';
    alignExpandedLetter();
    holdDeadline = Date.now() + HOLD_DURATION_MS;
    elements.skip.hidden = true;
    elements.holdStatus.textContent = 'Click anywhere to continue';
    elements.holdStatus.hidden = false;
    elements.overlay.focus({ preventScroll: true });
    later(updateCountdown, HOLD_DURATION_MS - (COUNTDOWN_SECONDS * 1000));
    later(skip, HOLD_DURATION_MS);
  }

  function expandLetter(duration) {
    if (phase !== 'opening') return;
    const firstRect = elements.letter.getBoundingClientRect();
    const targetRect = expandedTargetRect();
    const initialStyle = window.getComputedStyle(elements.letter);
    const initialBackground = initialStyle.background;
    const initialBorderColor = initialStyle.borderTopColor;
    const initialBoxShadow = initialStyle.boxShadow;
    const scale = firstRect.width / targetRect.width;
    const translateX = firstRect.left - targetRect.left;
    const translateY = firstRect.top - targetRect.top;
    const activeRun = runId;

    phase = 'expanding';
    document.body.classList.add('envelope-holding');
    elements.overlay.classList.add('morphing');
    elements.letter.classList.add('flight', 'expanded');
    elements.letter.style.left = `${targetRect.left}px`;
    elements.letter.style.top = `${targetRect.top}px`;
    elements.letter.style.width = `${targetRect.width}px`;
    elements.letter.style.transition = 'none';
    elements.letter.style.transformOrigin = 'top left';
    elements.letter.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`;
    elements.letter.style.opacity = '1';
    elements.letter.style.background = initialBackground;
    elements.letter.style.borderTopColor = initialBorderColor;
    elements.letter.style.boxShadow = initialBoxShadow;
    void elements.letter.offsetWidth;

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (activeRun !== runId || phase !== 'expanding') return;
        elements.letter.style.transition = [
          `transform ${duration}ms cubic-bezier(0.22, 1, 0.36, 1)`,
          `background ${duration}ms ease`,
          `box-shadow ${duration}ms ease`,
          `border-color ${duration}ms ease`
        ].join(', ');
        elements.letter.style.transform = 'translate3d(0, 0, 0) scale(1)';
        elements.letter.style.background = 'transparent';
        elements.letter.style.borderTopColor = 'transparent';
        elements.letter.style.boxShadow = 'none';
        later(beginHold, duration + 60);
      });
    });
  }

  function openEnvelope() {
    if (phase !== 'ready') return;
    clearTimers();
    phase = 'opening';
    elements.scene.setAttribute('aria-disabled', 'true');
    elements.scene.setAttribute('tabindex', '-1');
    elements.scene.classList.remove('pulsing');
    // The entrance animation leaves a transform on the scene. A transformed
    // ancestor would make the fixed expanded card position itself relative to
    // the envelope instead of the viewport, shifting it far to the right.
    elements.scene.style.animation = 'none';
    elements.scene.style.transform = 'none';
    elements.prompt.classList.remove('visible');
    elements.seal.classList.add('cracking');

    if (reducedMotion.matches) {
      elements.flap.classList.add('open');
      later(() => elements.letter.classList.add('rising'), 60);
      later(() => elements.body.classList.add('hidden'), 140);
      later(() => expandLetter(160), 220);
      return;
    }

    later(() => elements.flap.classList.add('open'), 280);
    later(() => elements.letter.classList.add('rising'), 900);
    later(() => elements.body.classList.add('hidden'), 1650);
    later(() => expandLetter(1200), 1850);
  }

  function play(onComplete) {
    clearTimers();
    phase = 'ready';
    completionCallback = typeof onComplete === 'function' ? onComplete : null;
    resetEnvelope();
    elements.overlay.hidden = false;
    elements.overlay.setAttribute('aria-hidden', 'false');
    elements.skip.hidden = false;
    elements.replay.hidden = true;
    document.body.classList.add('envelope-active');
    elements.scene.focus({ preventScroll: true });

    later(() => {
      elements.prompt.classList.add('visible');
      if (!reducedMotion.matches) elements.scene.classList.add('pulsing');
    }, reducedMotion.matches ? 80 : 700);
  }

  function cancel() {
    clearTimers();
    phase = 'idle';
    completionCallback = null;
    elements.overlay.hidden = true;
    elements.overlay.setAttribute('aria-hidden', 'true');
    elements.replay.hidden = true;
    document.body.classList.remove('envelope-active', 'envelope-holding');
  }

  elements.scene.addEventListener('click', openEnvelope);
  elements.scene.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openEnvelope();
  });
  elements.skip.addEventListener('click', (event) => {
    event.stopPropagation();
    skip();
  });
  elements.overlay.addEventListener('click', () => {
    if (phase === 'holding') skip();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && phase !== 'idle') {
      skip();
      return;
    }
    if (phase === 'holding' && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      skip();
    }
  });
  window.addEventListener('resize', () => {
    if (phase === 'holding') alignExpandedLetter();
  }, { passive: true });

  window.WeddingEnvelope = Object.freeze({ play, cancel });
})();

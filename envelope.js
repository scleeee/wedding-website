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
    heroLogo: document.querySelector('.hero-logo'),
    letterQuote: document.querySelector('#env-letter .env-letter-quote'),
    letterLogo: document.querySelector('#env-letter .env-letter-logo')
  };

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let phase = 'idle';
  let runId = 0;
  let timers = new Set();
  let completionCallback = null;

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
    elements.letter.setAttribute('aria-hidden', 'true');
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
    document.body.classList.remove('envelope-holding');
    document.body.classList.add('site-content-live');
    elements.overlay.classList.add('fade-out');
    later(complete, reducedMotion.matches ? 160 : 460);
  }

  function expandLetter(duration) {
    if (phase !== 'opening') return;
    if (!elements.heroQuote || !elements.heroLogo || !elements.letterLogo) {
      later(skip, 80);
      return;
    }

    const firstRect = elements.letter.getBoundingClientRect();
    const heroLogoRect = elements.heroLogo.getBoundingClientRect();
    const heroQuoteRect = elements.heroQuote.getBoundingClientRect();
    if (!firstRect.width || !heroLogoRect.width) {
      later(skip, 80);
      return;
    }

    const activeRun = runId;

    phase = 'expanding';
    document.body.classList.add('envelope-holding');
    elements.overlay.classList.add('morphing');
    elements.skip.hidden = true;
    elements.letter.classList.add('flight', 'expanded');
    elements.letter.setAttribute('aria-hidden', 'false');

    // Lay out the expanded letter on the hero, then nudge so the morph logo
    // lands on the exact hero-logo box (avoids a post-handoff jump).
    // Drop paper fill/shadow immediately — animating those backgrounds leaves
    // a visible rectangle over the real site during the scale.
    elements.letter.style.transition = 'none';
    elements.letter.style.transformOrigin = 'top left';
    elements.letter.style.transform = 'none';
    elements.letter.style.left = `${heroLogoRect.left}px`;
    elements.letter.style.top = `${heroQuoteRect.top}px`;
    elements.letter.style.width = `${heroLogoRect.width}px`;
    elements.letter.style.opacity = '1';
    elements.letter.style.background = 'transparent';
    elements.letter.style.border = 'none';
    elements.letter.style.boxShadow = 'none';
    void elements.letter.offsetWidth;

    const letterLogoRect = elements.letterLogo.getBoundingClientRect();
    const deltaX = heroLogoRect.left - letterLogoRect.left;
    const deltaY = heroLogoRect.top - letterLogoRect.top;
    const finalLeft = heroLogoRect.left + deltaX;
    const finalTop = heroQuoteRect.top + deltaY;
    elements.letter.style.left = `${finalLeft}px`;
    elements.letter.style.top = `${finalTop}px`;
    void elements.letter.offsetWidth;

    const lastRect = elements.letter.getBoundingClientRect();
    const scale = firstRect.width / lastRect.width;
    const translateX = firstRect.left - lastRect.left;
    const translateY = firstRect.top - lastRect.top;
    elements.letter.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`;
    void elements.letter.offsetWidth;

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (activeRun !== runId || phase !== 'expanding') return;
        elements.letter.style.transition =
          `transform ${duration}ms cubic-bezier(0.22, 1, 0.36, 1)`;
        elements.letter.style.transform = 'translate3d(0, 0, 0) scale(1)';
        // Atomic handoff: hide the morph letter in the same frame the real
        // hero is revealed so quote/logo never double on screen.
        later(() => {
          elements.letter.style.transition = 'none';
          elements.letter.style.opacity = '0';
          elements.letter.style.visibility = 'hidden';
          void elements.letter.offsetWidth;
          document.body.classList.remove('envelope-holding');
          document.body.classList.add('site-content-live');
          skip();
        }, duration + 40);
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
      later(() => expandLetter(180), 220);
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
    document.body.classList.remove('site-content-live');
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
    document.body.classList.remove('envelope-active', 'envelope-holding', 'site-content-live');
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
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && phase !== 'idle') skip();
  });

  window.WeddingEnvelope = Object.freeze({ play, cancel });
})();

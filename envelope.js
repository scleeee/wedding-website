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
    skip: document.getElementById('skip-intro'),
    replay: document.getElementById('replay-intro')
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
    elements.letter.classList.remove('rising', 'expanding');
    elements.body.classList.remove('hidden');
    elements.prompt.classList.remove('visible');
    elements.scene.classList.remove('pulsing');
    elements.scene.setAttribute('aria-disabled', 'false');
    elements.scene.setAttribute('tabindex', '0');

    // Force the entrance animation to restart when a guest chooses replay.
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
    document.body.classList.remove('envelope-active');
    if (callback) callback();
  }

  function skip() {
    if (phase === 'idle') return;
    elements.scene.setAttribute('aria-disabled', 'true');
    elements.scene.setAttribute('tabindex', '-1');
    elements.skip.hidden = true;
    elements.overlay.classList.add('fade-out');
    later(complete, reducedMotion.matches ? 160 : 460);
  }

  function openEnvelope() {
    if (phase !== 'ready') return;
    clearTimers();
    phase = 'opening';
    elements.scene.setAttribute('aria-disabled', 'true');
    elements.scene.setAttribute('tabindex', '-1');
    elements.scene.classList.remove('pulsing');
    elements.prompt.classList.remove('visible');
    elements.seal.classList.add('cracking');

    if (reducedMotion.matches) {
      elements.flap.classList.add('open');
      later(() => elements.letter.classList.add('rising'), 60);
      later(() => elements.body.classList.add('hidden'), 140);
      later(() => {
        elements.overlay.classList.add('morphing');
        elements.letter.classList.add('expanding');
      }, 220);
      later(complete, 430);
      return;
    }

    later(() => elements.flap.classList.add('open'), 280);
    later(() => elements.letter.classList.add('rising'), 900);
    later(() => elements.body.classList.add('hidden'), 1650);
    later(() => {
      elements.overlay.classList.add('morphing');
      elements.letter.classList.add('expanding');
    }, 2250);
    later(complete, 3450);
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
    document.body.classList.remove('envelope-active');
  }

  elements.scene.addEventListener('click', openEnvelope);
  elements.scene.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openEnvelope();
  });
  elements.skip.addEventListener('click', skip);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && phase !== 'idle') skip();
  });

  window.WeddingEnvelope = Object.freeze({ play, cancel });
})();

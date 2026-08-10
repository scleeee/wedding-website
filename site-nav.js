(function () {
  'use strict';

  const topNav = document.querySelector('.top-nav');
  if (topNav) {
    const navFadeDistance = 160;
    let navAnimationFrame;

    const syncNavBackground = () => {
      navAnimationFrame = undefined;
      const progress = Math.min(window.scrollY / navFadeDistance, 1);
      topNav.style.setProperty('--nav-background-opacity', (progress * 0.92).toFixed(3));
      topNav.style.setProperty('--nav-border-opacity', progress.toFixed(3));
      topNav.style.setProperty('--nav-shadow-opacity', (progress * 0.06).toFixed(3));
      topNav.style.setProperty('--nav-blur', `${(progress * 10).toFixed(2)}px`);
    };

    const requestNavBackgroundSync = () => {
      if (!navAnimationFrame) {
        navAnimationFrame = window.requestAnimationFrame(syncNavBackground);
      }
    };

    syncNavBackground();
    window.addEventListener('scroll', requestNavBackgroundSync, { passive: true });
  }

  const pageSidebar = document.querySelector('.page-sidebar');
  const pageSidebarToggle = pageSidebar && pageSidebar.querySelector('.page-sidebar-toggle');

  const closeSidebar = () => {
    if (!pageSidebar || !pageSidebarToggle) return;
    pageSidebar.classList.remove('is-open');
    pageSidebarToggle.setAttribute('aria-expanded', 'false');
  };

  if (pageSidebar && pageSidebarToggle) {
    pageSidebarToggle.addEventListener('click', () => {
      const isOpen = pageSidebar.classList.toggle('is-open');
      pageSidebarToggle.setAttribute('aria-expanded', String(isOpen));
    });

    document.addEventListener('click', (event) => {
      if (!pageSidebar.contains(event.target)) closeSidebar();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeSidebar();
    });
  }

  document.querySelectorAll('.page-sidebar a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (event) => {
      const target = document.querySelector(link.getAttribute('href'));
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.replaceState(null, '', link.getAttribute('href'));
      closeSidebar();
    });
  });
})();

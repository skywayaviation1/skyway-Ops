/* Skyway Ops marketing site — progressive enhancements only.
 * The page is fully readable with JavaScript disabled; this adds the sticky
 * nav shadow, the mobile drawer, scroll reveals, and the screenshot lightbox.
 */

(function () {
  'use strict';

  document.getElementById('year').textContent = new Date().getFullYear();

  // --- sticky nav shadow -------------------------------------------------
  const nav = document.getElementById('nav');
  const onScroll = () => nav.setAttribute('data-stuck', String(window.scrollY > 8));
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // --- mobile drawer -----------------------------------------------------
  const toggle = document.getElementById('navToggle');
  const drawer = document.getElementById('navDrawer');
  toggle.addEventListener('click', () => {
    const open = nav.getAttribute('data-open') === 'true';
    nav.setAttribute('data-open', String(!open));
    toggle.setAttribute('aria-expanded', String(!open));
  });
  drawer.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      nav.setAttribute('data-open', 'false');
      toggle.setAttribute('aria-expanded', 'false');
    });
  });

  // --- scroll reveals ----------------------------------------------------
  const revealables = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    revealables.forEach((el) => io.observe(el));
  } else {
    revealables.forEach((el) => el.classList.add('is-visible'));
  }

  // --- lightbox ----------------------------------------------------------
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxCaption = document.getElementById('lightboxCaption');
  const lightboxClose = document.getElementById('lightboxClose');

  const openLightbox = (src, alt, caption) => {
    lightboxImg.src = src;
    lightboxImg.alt = alt || '';
    lightboxCaption.textContent = caption || '';
    lightbox.setAttribute('data-open', 'true');
    lightbox.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  };

  const closeLightbox = () => {
    lightbox.setAttribute('data-open', 'false');
    lightbox.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  };

  document.querySelectorAll('[data-lightbox]').forEach((node) => {
    node.addEventListener('click', () => {
      const img = node.querySelector('img');
      if (!img) return;
      openLightbox(img.currentSrc || img.src, img.alt, node.getAttribute('data-caption'));
    });
  });

  lightboxClose.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox || event.target === lightboxImg.parentElement) closeLightbox();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && lightbox.getAttribute('data-open') === 'true') closeLightbox();
  });
})();

/*
 * Real job photos on service and city pages.
 *
 * A gallery marked data-job-photos="<service>" asks /api/job-photos for photos
 * the owner published (with the customer's permission): that city's jobs
 * first, then others for the same service. When there are none, the page keeps
 * the photos it was built with. Nothing here can publish or reveal anything;
 * the API only ever returns public copies and their descriptions.
 */
(function () {
  'use strict';

  var MAX_PHOTOS = 6;

  // Phones show the grid one photo per row, so cap it at four there; larger
  // screens show up to six (the API's limit) in two columns.
  function addPhoneCap() {
    if (document.getElementById('job-photos-phone-cap')) return;
    var style = document.createElement('style');
    style.id = 'job-photos-phone-cap';
    style.textContent = '@media (max-width:560px){[data-job-photos-loaded] > .fa-shot:nth-child(n+5){display:none}}';
    document.head.appendChild(style);
  }

  function render(gallery, photos, localCount) {
    addPhoneCap();
    // One posted photo: pair it with the page's first built-in photo so the
    // two-column grid stays full; on a page with none, centre it.
    var keep = photos.length === 1 ? gallery.querySelector('.fa-shot') : null;
    var figures = photos.map(function (photo) {
      var figure = document.createElement('figure');
      figure.className = 'fa-shot';
      var frame = document.createElement('div');
      frame.className = 'frame';
      var img = document.createElement('img');
      img.src = photo.url;
      img.alt = photo.alt || '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.width = 760;
      img.height = 570;
      frame.appendChild(img);
      figure.appendChild(frame);
      return figure;
    });
    if (keep) figures.push(keep);
    else if (figures.length === 1) {
      figures[0].style.gridColumn = '1 / -1';
      figures[0].style.width = '100%';
      figures[0].style.maxWidth = '540px';
      figures[0].style.justifySelf = 'center';
    }
    gallery.replaceChildren.apply(gallery, figures);
    gallery.style.display = '';
    gallery.setAttribute('data-job-photos-loaded', String(photos.length));

    var cityName = gallery.getAttribute('data-job-city-name');
    var section = gallery.closest('section');
    var kicker = section && section.querySelector('.fa-kicker');
    if (kicker && cityName && localCount > 0) kicker.textContent = 'Recent work in ' + cityName;
  }

  function load(gallery) {
    var service = gallery.getAttribute('data-job-photos');
    var city = gallery.getAttribute('data-job-city') || '';
    var url = '/api/job-photos?service=' + encodeURIComponent(service) + (city ? '&city=' + encodeURIComponent(city) : '');
    fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : { photos: [] }; })
      .then(function (data) {
        var photos = Array.isArray(data.photos) ? data.photos.filter(function (p) { return p && p.url; }).slice(0, MAX_PHOTOS) : [];
        // The grid is two columns: an odd count leaves one photo alone on the
        // last row, so show an even number (one photo stays one photo).
        if (photos.length > 1 && photos.length % 2) photos = photos.slice(0, photos.length - 1);
        if (photos.length) render(gallery, photos, Number(data.localCount) || 0);
      })
      .catch(function () { /* keep the built-in photos */ });
  }

  function start() {
    var galleries = document.querySelectorAll('[data-job-photos]');
    Array.prototype.forEach.call(galleries, load);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

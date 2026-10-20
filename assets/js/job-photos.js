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

  function render(gallery, photos, localCount) {
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
        var photos = Array.isArray(data.photos) ? data.photos.filter(function (p) { return p && p.url; }) : [];
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

/* App entrypoint - initializes UI behaviors and demonstrates API usage */
import { get, post } from './api.js';

document.addEventListener('DOMContentLoaded', () => {
  get('/api/health')
    .then(data => console.log('API health:', data))
    .catch(err => console.warn('API health check failed', err));

  const contactForm = document.querySelector('#contact-form');
  if (contactForm) {
    contactForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = Object.fromEntries(new FormData(contactForm).entries());
      try {
        await post('/api/contact', formData);
        alert('Submitted successfully');
      } catch (err) {
        alert('Submission failed');
      }
    });
  }
});

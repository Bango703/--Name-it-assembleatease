// api/booking.js — Vercel Serverless Function
// Receives booking form data and sends emails via Resend

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { service, name, phone, email, address, date, time, details } = req.body;

  // Validate required fields
  if (!service || !name || !phone || !email || !address || !date || !time || !details) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const YOUR_EMAIL     = process.env.NOTIFY_EMAIL || 'service@assembleatease.com';

  try {
    // Email 1 — Notify YOU with full booking details
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'AssembleAtEase Bookings <bookings@assembleatease.com>',
        to: [YOUR_EMAIL],
        subject: `New Booking Request — ${service} from ${name}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 2rem;">
            <div style="background: #00bcd4; padding: 1.5rem 2rem; border-radius: 12px 12px 0 0;">
              <h1 style="color: #fff; margin: 0; font-size: 1.4rem;">New Booking Request</h1>
              <p style="color: rgba(255,255,255,0.85); margin: 0.4rem 0 0; font-size: 0.9rem;">Received via AssembleAtEase website</p>
            </div>
            <div style="background: #f9fafb; border: 1px solid #e5e7eb; padding: 2rem; border-radius: 0 0 12px 12px;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 0.6rem 0; color: #6b7280; font-size: 0.85rem; width: 140px;">Service</td><td style="padding: 0.6rem 0; font-weight: 600; color: #0d1117;">${service}</td></tr>
                <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 0.6rem 0; color: #6b7280; font-size: 0.85rem;">Name</td><td style="padding: 0.6rem 0; font-weight: 600; color: #0d1117;">${name}</td></tr>
                <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 0.6rem 0; color: #6b7280; font-size: 0.85rem;">Phone</td><td style="padding: 0.6rem 0; font-weight: 600; color: #0d1117;"><a href="tel:${phone}" style="color: #00bcd4;">${phone}</a></td></tr>
                <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 0.6rem 0; color: #6b7280; font-size: 0.85rem;">Email</td><td style="padding: 0.6rem 0; font-weight: 600; color: #0d1117;"><a href="mailto:${email}" style="color: #00bcd4;">${email}</a></td></tr>
                <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 0.6rem 0; color: #6b7280; font-size: 0.85rem;">Address</td><td style="padding: 0.6rem 0; font-weight: 600; color: #0d1117;">${address}</td></tr>
                <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 0.6rem 0; color: #6b7280; font-size: 0.85rem;">Date</td><td style="padding: 0.6rem 0; font-weight: 600; color: #0d1117;">${date}</td></tr>
                <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 0.6rem 0; color: #6b7280; font-size: 0.85rem;">Time</td><td style="padding: 0.6rem 0; font-weight: 600; color: #0d1117;">${time}</td></tr>
                <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 0.6rem 0; color: #6b7280; font-size: 0.85rem; vertical-align: top;">Details</td><td style="padding: 0.6rem 0; color: #0d1117;">${details}</td></tr>
              </table>
              <div style="margin-top: 1.5rem; padding: 1rem; background: #e0f7fa; border-radius: 8px; font-size: 0.85rem; color: #006064;">
                Reply to this email or call ${phone} to confirm the appointment.
              </div>
            </div>
          </div>
        `,
        reply_to: email,
      }),
    });

    // Email 2 — Confirmation to customer
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'AssembleAtEase <service@assembleatease.com>',
        to: [email],
        subject: `Booking Confirmed — We received your request!`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 2rem;">
            <div style="background: #00bcd4; padding: 1.5rem 2rem; border-radius: 12px 12px 0 0; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 1.4rem;">AssembleAtEase</h1>
              <p style="color: rgba(255,255,255,0.85); margin: 0.4rem 0 0;">Austin, TX</p>
            </div>
            <div style="background: #f9fafb; border: 1px solid #e5e7eb; padding: 2rem; border-radius: 0 0 12px 12px; text-align: center;">
              <div style="width: 64px; height: 64px; background: #e0f7fa; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 1rem; font-size: 1.8rem;">&#10003;</div>
              <h2 style="color: #0d1117; margin: 0 0 0.5rem;">We got your request, ${name}!</h2>
              <p style="color: #6b7280; line-height: 1.7; margin-bottom: 1.5rem;">We will contact you within <strong>1 hour</strong> to confirm your appointment. Here is a summary of what you booked:</p>
              <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 1.25rem; text-align: left; margin-bottom: 1.5rem;">
                <div style="display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid #f3f4f6;"><span style="color: #6b7280; font-size: 0.85rem;">Service</span><span style="font-weight: 600;">${service}</span></div>
                <div style="display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid #f3f4f6;"><span style="color: #6b7280; font-size: 0.85rem;">Date</span><span style="font-weight: 600;">${date}</span></div>
                <div style="display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid #f3f4f6;"><span style="color: #6b7280; font-size: 0.85rem;">Time</span><span style="font-weight: 600;">${time}</span></div>
                <div style="display: flex; justify-content: space-between; padding: 0.5rem 0;"><span style="color: #6b7280; font-size: 0.85rem;">Address</span><span style="font-weight: 600;">${address}</span></div>
              </div>
              <p style="color: #6b7280; font-size: 0.875rem;">Questions? Call or text us at <a href="tel:7372906129" style="color: #00bcd4; font-weight: 600;">(737) 290-6129</a></p>
              <p style="color: #6b7280; font-size: 0.875rem;">Payment is only required after the job is completed.</p>
            </div>
          </div>
        `,
      }),
    });

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Email error:', error);
    return res.status(500).json({ error: 'Failed to send email' });
  }
}
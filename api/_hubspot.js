const HUBSPOT_API = 'https://api.hubapi.com';

function getToken() {
  return process.env.HUBSPOT_ACCESS_TOKEN;
}

function headers() {
  return {
    'Authorization': 'Bearer ' + getToken(),
    'Content-Type': 'application/json',
  };
}

/**
 * Search for existing contact by email.
 * Returns contact ID or null.
 */
async function findContactByEmail(email) {
  const resp = await fetch(HUBSPOT_API + '/crm/v3/objects/contacts/search', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      filterGroups: [{
        filters: [{ propertyName: 'email', operator: 'EQ', value: email }]
      }],
      limit: 1,
    }),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.total > 0 ? data.results[0].id : null;
}

/**
 * Create or update a HubSpot contact.
 * Returns contact ID.
 */
async function upsertContact({ email, name, phone, address, lifecycleStage }) {
  const properties = { email };
  if (name) {
    const parts = name.trim().split(/\s+/);
    properties.firstname = parts[0];
    if (parts.length > 1) properties.lastname = parts.slice(1).join(' ');
  }
  if (phone) properties.phone = phone;
  if (address) properties.address = address;
  if (lifecycleStage) properties.lifecyclestage = lifecycleStage;

  const existingId = await findContactByEmail(email);

  if (existingId) {
    // Update existing contact
    const resp = await fetch(HUBSPOT_API + '/crm/v3/objects/contacts/' + existingId, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ properties }),
    });
    return existingId;
  }

  // Create new contact
  const resp = await fetch(HUBSPOT_API + '/crm/v3/objects/contacts', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ properties }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error('HubSpot create contact error:', err);
    return null;
  }
  const data = await resp.json();
  return data.id;
}

/**
 * Create a deal in HubSpot and associate it with a contact.
 */
async function createDeal({ contactId, dealName, amount, service, date, time, details }) {
  const properties = {
    dealname: dealName,
    pipeline: 'default',
    dealstage: 'qualifiedtobuy',
  };
  if (amount) properties.amount = String(amount);
  if (service) properties.description = 'Services: ' + service;
  if (date) properties.description = (properties.description || '') + '\nDate: ' + date;
  if (time) properties.description = (properties.description || '') + '\nTime: ' + time;
  if (details) properties.description = (properties.description || '') + '\nDetails: ' + details;

  const body = {
    properties,
    associations: contactId ? [{
      to: { id: contactId },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
    }] : [],
  };

  const resp = await fetch(HUBSPOT_API + '/crm/v3/objects/deals', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error('HubSpot create deal error:', err);
    return null;
  }
  const data = await resp.json();
  return data.id;
}

/**
 * Add a note to a contact.
 */
async function addNote({ contactId, body }) {
  const resp = await fetch(HUBSPOT_API + '/crm/v3/objects/notes', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      properties: { hs_note_body: body, hs_timestamp: new Date().toISOString() },
      associations: contactId ? [{
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
      }] : [],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error('HubSpot add note error:', err);
  }
}

export { upsertContact, createDeal, addNote, updateDealStage };

/**
 * Update the pipeline stage of an existing HubSpot deal.
 * stage should be a valid HubSpot dealstage internal value.
 */
async function updateDealStage(dealId, stage) {
  if (!dealId || !stage) return;
  const resp = await fetch(HUBSPOT_API + '/crm/v3/objects/deals/' + dealId, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ properties: { dealstage: stage } }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error('HubSpot updateDealStage error:', err);
  }
}




export default async function handler(req, res) {
  const key = process.env.PERSONA_API_KEY;
  const gov = process.env.PERSONA_TEMPLATE_GOV_ID;
  const selfie = process.env.PERSONA_TEMPLATE_SELFIE;
  const db = process.env.PERSONA_TEMPLATE_DATABASE;
  const secret = process.env.PERSONA_WEBHOOK_SECRET;
  return res.status(200).json({
    PERSONA_API_KEY: key ? 'SET (' + key.substring(0,15) + '...)' : 'MISSING',
    PERSONA_TEMPLATE_GOV_ID: gov ? 'SET (' + gov + ')' : 'MISSING',
    PERSONA_TEMPLATE_SELFIE: selfie ? 'SET (' + selfie + ')' : 'MISSING',
    PERSONA_TEMPLATE_DATABASE: db ? 'SET (' + db + ')' : 'MISSING',
    PERSONA_WEBHOOK_SECRET: secret ? 'SET' : 'MISSING',
    allPresent: !!(key && gov && selfie && db && secret)
  });
}

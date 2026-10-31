/**
 * Finanvô — Cloudflare Worker
 * Recebe webhooks do Hotmart e atualiza o plano no Firebase Firestore
 */

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    // Verificar token Hotmart
    const hottok = request.headers.get('X-Hotmart-Hottok') || new URL(request.url).searchParams.get('hottok');
    if (env.HOTMART_HOTTOK && hottok !== env.HOTMART_HOTTOK) return new Response('Unauthorized', { status: 401 });

    let payload;
    try { payload = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }

    const evento = payload.event || payload.data?.event;
    const compra = payload.data?.purchase || payload.purchase;
    const produto = payload.data?.product || payload.product;
    const comprador = payload.data?.buyer || payload.buyer;
    const email = comprador?.email;

    if (!email || !evento) return new Response('OK', { status: 200 });

    const ATIVAR   = ['PURCHASE_APPROVED','PURCHASE_COMPLETE','SUBSCRIPTION_REACTIVATED','PURCHASE_REACTIVATED'];
    const CANCELAR = ['PURCHASE_CANCELED','PURCHASE_REFUNDED','SUBSCRIPTION_CANCELLATION','PURCHASE_CHARGEBACK'];

    // Detectar plano pelo nome do produto
    const nome = (produto?.name || '').toLowerCase();
    let plano = null;
    if (nome.includes('premium'))                                        plano = 'premium';
    else if (nome.includes('famil'))                                     plano = 'familia';
    else if (nome.includes('basic') || nome.includes('básic') || nome.includes('pro')) plano = 'pro';

    if (!plano && !CANCELAR.includes(evento)) return new Response('OK - produto não mapeado', { status: 200 });

    try {
      if (ATIVAR.includes(evento))   await setPlano(env, email, plano, compra);
      if (CANCELAR.includes(evento)) await setPlano(env, email, 'gratuito', compra);
    } catch(e) {
      console.error(e.message);
      return new Response('Erro: ' + e.message, { status: 500 });
    }

    return new Response('OK', { status: 200 });
  }
};

async function setPlano(env, email, plano, compra) {
  const token = await getToken(env);
  // Buscar UID pelo email
  const r1 = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:lookup`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: [email] })
  });
  const d1 = await r1.json();
  const uid = d1.users?.[0]?.localId;

  const fields = {
    plano: { stringValue: plano },
    planoAtualizadoEm: { stringValue: new Date().toISOString() }
  };

  if (uid) {
    // Usuário já tem conta — atualiza direto
    await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}?updateMask.fieldPaths=plano&updateMask.fieldPaths=planoAtualizadoEm`, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
  } else {
    // Usuário ainda não criou conta — salva como pendente
    const key = email.replace(/[.@]/g, '_');
    await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/planos_pendentes/${key}`, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { ...fields, email: { stringValue: email } } })
    });
  }
}

async function getToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => btoa(JSON.stringify(o)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const sig = b64({ alg:'RS256', typ:'JWT' }) + '.' + b64({
    iss: env.FIREBASE_CLIENT_EMAIL, sub: env.FIREBASE_CLIENT_EMAIL,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit'
  });
  const pem = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g,'\n');
  const raw = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|[\n\r]/g,'')), c=>c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', raw.buffer, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(sig));
  const jwt = sig + '.' + btoa(String.fromCharCode(...new Uint8Array(signed))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const tr = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  })).json();
  if (!tr.access_token) throw new Error('Token falhou: ' + JSON.stringify(tr));
  return tr.access_token;
}

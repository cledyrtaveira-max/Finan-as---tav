/**
 * Finanvô — Cloudflare Worker
 * Recebe webhooks do Hotmart e atualiza o plano no Firebase Firestore
 */

// ── Rate limit: máx 20 requisições por IP a cada 60 segundos ────────
// Usa KV do Cloudflare (configure: wrangler kv namespace create "RATE_LIMIT_KV")
// Se KV não estiver configurado, rate limit é ignorado (graceful degradation).
async function checkRateLimit(env, ip) {
  if (!env.RATE_LIMIT_KV) return true; // KV não configurado → permite
  const key = `rl:${ip}`;
  try {
    const raw = await env.RATE_LIMIT_KV.get(key);
    const count = raw ? parseInt(raw) : 0;
    if (count >= 20) return false; // bloqueado
    // Incrementa contador; expira em 60s
    await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: 60 });
    return true;
  } catch (_) {
    return true; // em caso de erro no KV, permite a requisição
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://appfinanvo.com.br',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // OPTIONS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── C3 FIX: Endpoint /ativar-pendente ────────────────────────────
    // Chamado pelo app quando o usuário faz login e há um plano pendente.
    // Autentica via Firebase ID token; ativa o plano pendente no perfil.
    if (url.pathname === '/ativar-pendente' && request.method === 'POST') {
      return handleAtivarPendente(request, env);
    }

    // ── Endpoint /set-admin ─────────────────────────────────────────
    // Define custom claim admin:true em um usuário Firebase.
    // Protegido por ADMIN_SECRET (env var). Uso único de setup.
    // POST { secret: "...", email: "..." }
    if (url.pathname === '/set-admin' && request.method === 'POST') {
      return handleSetAdmin(request, env);
    }

    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    // I6 FIX: rate limit por IP — evita flood/abuso do webhook
    const ip = request.headers.get('CF-Connecting-IP')
            || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
            || 'unknown';
    const allowed = await checkRateLimit(env, ip);
    if (!allowed) {
      return new Response('Too Many Requests', {
        status: 429,
        headers: { 'Retry-After': '60' }
      });
    }

    // Ler body como texto para validar HMAC antes de parsear
    const rawBody = await request.text();

    // ── Validação HMAC-SHA1 do Hotmart ───────────────────────────────
    // Hotmart envia X-Hotmart-Webhook-Token com HMAC-SHA1(hottok, rawBody)
    // Falha fechado: sem o segredo configurado, nenhum webhook é aceito.
    if (!env.HOTMART_HOTTOK) {
      console.error('HOTMART_HOTTOK não configurado — webhook recusado');
      return new Response('Server misconfigured', { status: 500 });
    }
    const signature = request.headers.get('X-Hotmart-Webhook-Token') || '';
    if (signature) {
      // Validar HMAC apenas se o header estiver presente
      const isValid = await verifyHmac(env.HOTMART_HOTTOK, rawBody, signature);
      if (!isValid) return new Response('Unauthorized', { status: 401 });
    } else {
      // hottok aceito somente pelo header X-HOTMART-HOTTOK (nunca pela URL),
      // comparado em tempo constante.
      const hottok = request.headers.get('X-HOTMART-HOTTOK') || '';
      if (!hottok || !(await timingSafeEqualStr(hottok, env.HOTMART_HOTTOK))) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    let payload;
    try { payload = JSON.parse(rawBody); } catch { return new Response('Invalid JSON', { status: 400 }); }

    const evento = payload.event || payload.data?.event;
    const compra = payload.data?.purchase || payload.purchase;
    const produto = payload.data?.product || payload.product;
    const comprador = payload.data?.buyer || payload.buyer;
    const email = comprador?.email;

    if (!email || !evento) return new Response('OK', { status: 200 });

    const ATIVAR   = ['PURCHASE_APPROVED','PURCHASE_COMPLETE','SUBSCRIPTION_REACTIVATED','PURCHASE_REACTIVATED'];
    const CANCELAR = ['PURCHASE_CANCELED','PURCHASE_REFUNDED','SUBSCRIPTION_CANCELLATION','PURCHASE_CHARGEBACK'];

    // Detectar plano pelo ID do produto (mais confiável que pelo nome)
    const MAPA_PRODUTO = {
      'U108262502C': 'pro',      // Básico
      'U108265754P': 'familia',  // Família
      'A108265910E': 'premium'   // Premium
    };
    const prodId = String(produto?.id || produto?.ucode || '');
    let plano = MAPA_PRODUTO[prodId] || null;

    // Fallback pelo nome (cuidado: checar basic/pro ANTES de famil para evitar
    // que "Básico — Controle Financeiro Familiar" seja classificado como família)
    if (!plano) {
      const nome = (produto?.name || '').toLowerCase();
      if (nome.includes('premium'))                                        plano = 'premium';
      else if (nome.includes('basic') || nome.includes('básic') || nome.includes('pro')) plano = 'pro';
      else if (nome.includes('famil'))                                     plano = 'familia';
    }

    if (!plano && !CANCELAR.includes(evento)) return new Response('OK - produto não mapeado', { status: 200 });

    try {
      if (ATIVAR.includes(evento))   await setPlano(env, email, plano, compra);
      if (CANCELAR.includes(evento)) await setPlano(env, email, 'gratuito', compra);
      // Indique e Ganhe: o indicador só ganha depois que o pagamento do indicado foi
      // CONFIRMADO e o prazo de garantia passou (PURCHASE_COMPLETE). Estorno/chargeback
      // depois disso desfaz o bônus.
      if (evento === 'PURCHASE_COMPLETE') await recompensarIndicacao(env, email);
      if (evento === 'PURCHASE_REFUNDED' || evento === 'PURCHASE_CHARGEBACK') await revogarIndicacao(env, email);
    } catch(e) {
      console.error(e.message);
      return new Response('Erro: ' + e.message, { status: 500 });
    }

    return new Response('OK', { status: 200 });
  }
};

// ── C3 FIX: Ativar plano pendente quando usuário cria conta após a compra ──
// O app chama POST /ativar-pendente com { idToken } após login.
// O worker verifica o token, lê planos_pendentes e aplica o plano.
async function handleAtivarPendente(request, env) {
  let body;
  try { body = await request.json(); } catch {
    return new Response('Invalid JSON', { status: 400, headers: CORS_HEADERS });
  }

  const idToken = body.idToken || request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!idToken) return new Response('Missing idToken', { status: 401, headers: CORS_HEADERS });

  // Verificar token Firebase
  const uid = await verifyFirebaseToken(idToken, env.FIREBASE_PROJECT_ID);
  if (!uid) return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });

  try {
    const token = await getToken(env);

    // Buscar email do usuário
    const r1 = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:lookup`,
      { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ localId: [uid] }) }
    );
    const d1 = await r1.json();
    const email = d1.users?.[0]?.email;
    if (!email) return new Response('User not found', { status: 404, headers: CORS_HEADERS });

    // Só ativa compra pendente para quem provou ser dono do e-mail. Sem isso, qualquer
    // pessoa criava conta com o e-mail de um comprador e ficava com o plano dele.
    if (d1.users[0].emailVerified !== true) {
      return new Response(JSON.stringify({ ok: false, msg: 'email_nao_verificado' }), {
        status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    // Buscar plano pendente (chave normalizada em minúsculas, igual às regras do Firestore)
    const key = email.toLowerCase().replace(/[.@]/g, '_');
    const r2 = await fetch(
      `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/planos_pendentes/${key}`,
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    if (r2.status === 404) {
      return new Response(JSON.stringify({ ok: true, msg: 'sem_pendente' }), {
        status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }
    const d2 = await r2.json();
    const plano = d2.fields?.plano?.stringValue;
    if (!plano || plano === 'gratuito') {
      return new Response(JSON.stringify({ ok: true, msg: 'sem_pendente' }), {
        status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    // Aplicar plano no perfil do usuário
    const planoExpira = d2.fields?.planoExpira?.stringValue || null;
    const maskFields = ['plano', 'planoAtualizadoEm', 'planoExpira'];
    const maskQuery  = maskFields.map(f => `updateMask.fieldPaths=${f}`).join('&');
    const fields = {
      plano:             { stringValue: plano },
      planoAtualizadoEm: { stringValue: new Date().toISOString() },
      planoExpira:       planoExpira ? { stringValue: planoExpira } : { nullValue: null }
    };

    const rPerfil = await fetch(
      `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}?${maskQuery}`,
      { method: 'PATCH', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }) }
    );
    // Se o perfil não foi atualizado, a pendência fica para nova tentativa (não se perde a compra).
    if (!rPerfil.ok) throw new Error('Falha ao gravar o plano no perfil (HTTP ' + rPerfil.status + ')');

    // Remover plano pendente — só depois que o perfil foi gravado com sucesso
    await fetch(
      `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/planos_pendentes/${key}`,
      { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } }
    );

    // Atualizar planoDono em famílias se necessário
    await atualizarPlanoDono(env, token, uid, plano);

    return new Response(JSON.stringify({ ok: true, plano, msg: 'ativado' }), {
      status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  } catch(e) {
    console.error('[ativar-pendente]', e.message);
    return new Response('Erro: ' + e.message, { status: 500, headers: CORS_HEADERS });
  }
}

// ── Verificar Firebase ID token via Google Public Keys ──────────────
async function verifyFirebaseToken(idToken, projectId) {
  try {
    // Decodificar header e payload (sem verificar assinatura aqui — usamos a API do Firebase)
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=AIzaSyCy4hUoPKlAuutoSZhliLetovHr9EK1JvA`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }) }
    );
    const d = await r.json();
    if (d.error || !d.users?.length) return null;
    return d.users[0].localId;
  } catch { return null; }
}

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

  // Calcular data de expiração do plano
  const planoExpira = calcularExpiracao(plano, compra);

  const fields = {
    plano:             { stringValue: plano },
    planoAtualizadoEm: { stringValue: new Date().toISOString() },
    planoExpira:       planoExpira ? { stringValue: planoExpira } : { nullValue: null }
  };

  const maskFields = ['plano', 'planoAtualizadoEm', 'planoExpira'];
  const maskQuery  = maskFields.map(f => `updateMask.fieldPaths=${f}`).join('&');

  if (uid) {
    // Usuário já tem conta — atualiza direto
    await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}?${maskQuery}`, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });

    // ── PEN-02: Atualizar planoDono em familias onde este usuário é dono ──
    // Busca todas as famílias onde donoUid == uid e atualiza planoDono
    await atualizarPlanoDono(env, token, uid, plano);
  } else {
    // Usuário ainda não criou conta — salva como pendente
    const key = email.toLowerCase().replace(/[.@]/g, '_');
    await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/planos_pendentes/${key}`, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { ...fields, email: { stringValue: email } } })
    });
  }
}

// ── Atualiza planoDono nas famílias onde o usuário é dono ───────────
// Cloudflare Workers não suporta queries Firestore com filtro diretamente
// via REST sem índice — usamos collectionGroup query via REST v1
async function atualizarPlanoDono(env, token, uid, plano) {
  try {
    // Query: familias WHERE donoUid == uid
    const queryBody = {
      structuredQuery: {
        from: [{ collectionId: 'familias', allDescendants: false }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'donoUid' },
            op: 'EQUAL',
            value: { stringValue: uid }
          }
        },
        limit: 20
      }
    };
    const qr = await fetch(
      `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`,
      {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(queryBody)
      }
    );
    const rows = await qr.json();

    // Atualiza cada família encontrada
    await Promise.all((rows || []).map(async row => {
      const name = row.document?.name;
      if (!name) return;
      await fetch(`${name}?updateMask.fieldPaths=planoDono`, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { planoDono: { stringValue: plano } } })
      });
    }));
  } catch(e) {
    // Não bloquear o fluxo principal se a atualização de família falhar
    console.warn('atualizarPlanoDono falhou:', e.message);
  }
}

/**
 * Calcula a data de expiração do plano com base nos dados da compra Hotmart.
 *
 * Prioridade:
 *  1. compra.date_next_charge  — próxima cobrança (assinaturas recorrentes)
 *  2. compra.recurrency_period — período em meses + data da compra
 *  3. Fallback: +31 dias a partir de agora (plano vitalício ou dado ausente)
 *
 * Para plano == 'gratuito' (cancelamento), retorna null (sem expiração).
 */
function calcularExpiracao(plano, compra) {
  if (plano === 'gratuito') return null;

  // 1) Próxima cobrança já conhecida pela Hotmart
  const nextCharge = compra?.date_next_charge;
  if (nextCharge) {
    // Pode vir como timestamp ms ou ISO string
    const d = typeof nextCharge === 'number'
      ? new Date(nextCharge)
      : new Date(nextCharge);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  // 2) Calcular a partir da data da compra + período de recorrência
  const recurrencyPeriod = compra?.recurrency_period; // em meses (ex: 1, 3, 12)
  const orderDateRaw = compra?.order_date || compra?.approved_date;
  if (recurrencyPeriod && orderDateRaw) {
    const base = typeof orderDateRaw === 'number'
      ? new Date(orderDateRaw)
      : new Date(orderDateRaw);
    if (!isNaN(base.getTime())) {
      base.setMonth(base.getMonth() + Number(recurrencyPeriod));
      return base.toISOString();
    }
  }

  // 3) Fallback: 31 dias a partir de agora
  const fallback = new Date();
  fallback.setDate(fallback.getDate() + 31);
  return fallback.toISOString();
}

// ── Validação HMAC-SHA1 do Hotmart ──────────────────────────────────
// Hotmart envia X-Hotmart-Webhook-Token = HMAC-SHA1(hottok, corpo)
// Comparação de strings em tempo constante: compara os SHA-256 das duas,
// que têm sempre o mesmo tamanho, sem sair do laço no primeiro byte diferente.
async function timingSafeEqualStr(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b)))
  ]);
  const va = new Uint8Array(ha), vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function verifyHmac(secret, body, signature) {
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-1' },
      false, ['sign']
    );
    const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
    const computed = Array.from(new Uint8Array(mac))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    // Comparação em tempo constante básica
    if (computed.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < computed.length; i++) {
      diff |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return diff === 0;
  } catch { return false; }
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

// ══════════════════════════════════════════════════════════════════
// Indique e Ganhe — recompensa só após pagamento confirmado
// ══════════════════════════════════════════════════════════════════
const BONUS_INDICACAO_DIAS = 30;
const FS = env => `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

async function uidPorEmail(env, token, email) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:lookup`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: [email] })
  });
  const d = await r.json();
  return d.users?.[0]?.localId || null;
}

// Indicação do comprador (indicadoUid == uid). Sem índice composto: filtra só por indicadoUid.
async function indicacaoDoIndicado(env, token, uid) {
  const r = await fetch(`${FS(env)}:runQuery`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'indicacoes' }],
      where: { fieldFilter: { field: { fieldPath: 'indicadoUid' }, op: 'EQUAL', value: { stringValue: uid } } },
      limit: 1
    }})
  });
  const rows = await r.json();
  return Array.isArray(rows) ? (rows.find(x => x.document)?.document || null) : null;
}

// Soma (ou subtrai) dias em planoBonusExpira do indicador. Nunca abaixo de "agora".
async function ajustarBonusIndicador(env, token, indicadorUid, dias) {
  const g = await fetch(`${FS(env)}/users/${indicadorUid}`, { headers: { 'Authorization': 'Bearer ' + token } });
  if (!g.ok) throw new Error('indicador não encontrado');
  const u = await g.json();
  const agora = Date.now();
  const atual = Date.parse(u.fields?.planoBonusExpira?.stringValue || '') || 0;
  const base = Math.max(atual, agora);
  const novo = dias >= 0 ? base + dias * 864e5 : Math.max(agora, atual + dias * 864e5);
  const mask = ['planoBonus', 'planoBonusExpira'].map(f => `updateMask.fieldPaths=${f}`).join('&');
  const p = await fetch(`${FS(env)}/users/${indicadorUid}?${mask}`, {
    method: 'PATCH',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: {
      planoBonus: { stringValue: 'premium' },
      planoBonusExpira: { stringValue: new Date(novo).toISOString() }
    }})
  });
  if (!p.ok) throw new Error('falha ao gravar bônus do indicador: ' + p.status);
}

async function patchIndicacao(env, token, docName, campos) {
  const mask = Object.keys(campos).map(f => `updateMask.fieldPaths=${f}`).join('&');
  const r = await fetch(`https://firestore.googleapis.com/v1/${docName}?${mask}`, {
    method: 'PATCH',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: campos })
  });
  if (!r.ok) throw new Error('falha ao atualizar indicação: ' + r.status);
}

async function recompensarIndicacao(env, emailComprador) {
  const token = await getToken(env);
  const uid = await uidPorEmail(env, token, emailComprador);
  if (!uid) return;
  const doc = await indicacaoDoIndicado(env, token, uid);
  if (!doc) return;
  const f = doc.fields || {};
  const indicadorUid = f.indicadorUid?.stringValue;
  // Já recompensada (ou revogada): não paga duas vezes (o Hotmart pode reenviar o evento).
  if (f.ativo?.booleanValue === true || f.revogada?.booleanValue === true || !indicadorUid) return;
  // Marca como ativa ANTES de creditar (evita crédito duplicado se a Hotmart reenviar o
  // evento); se o crédito falhar, desfaz a marca e devolve erro para a Hotmart reenviar.
  await patchIndicacao(env, token, doc.name, {
    ativo: { booleanValue: true },
    dataAtivacao: { stringValue: new Date().toISOString() },
    motivo: { stringValue: 'compra_confirmada' }
  });
  try {
    await ajustarBonusIndicador(env, token, indicadorUid, BONUS_INDICACAO_DIAS);
  } catch (e) {
    await patchIndicacao(env, token, doc.name, { ativo: { booleanValue: false } }).catch(() => {});
    throw e;
  }
}

async function revogarIndicacao(env, emailComprador) {
  const token = await getToken(env);
  const uid = await uidPorEmail(env, token, emailComprador);
  if (!uid) return;
  const doc = await indicacaoDoIndicado(env, token, uid);
  if (!doc) return;
  const f = doc.fields || {};
  const indicadorUid = f.indicadorUid?.stringValue;
  if (f.revogada?.booleanValue === true) return;
  // Só desfaz o que já foi pago; se ainda não tinha sido recompensada, só impede que seja.
  if (f.ativo?.booleanValue === true && indicadorUid) {
    await ajustarBonusIndicador(env, token, indicadorUid, -BONUS_INDICACAO_DIAS);
  }
  await patchIndicacao(env, token, doc.name, {
    revogada: { booleanValue: true },
    ativo: { booleanValue: false },
    dataRevogacao: { stringValue: new Date().toISOString() }
  });
}

// ── handleSetAdmin: seta custom claim admin:true via Firebase Auth REST API ─
// Uso único de setup. Protegido por env.ADMIN_SECRET.
// POST { secret: "...", email: "..." }
async function handleSetAdmin(request, env) {
  if (!env.ADMIN_SECRET) {
    return new Response(JSON.stringify({ error: 'ADMIN_SECRET não configurado' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
  let body;
  try { body = await request.json(); } catch(_) {
    return new Response(JSON.stringify({ error: 'Body inválido' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (body.secret !== env.ADMIN_SECRET) {
    return new Response(JSON.stringify({ error: 'Não autorizado' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (!body.email) {
    return new Response(JSON.stringify({ error: 'email obrigatório' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }
  try {
    const token = await getToken(env);
    // Buscar UID pelo email
    const r1 = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:lookup`,
      {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: [body.email] })
      }
    );
    const d1 = await r1.json();
    const uid = d1.users?.[0]?.localId;
    if (!uid) {
      return new Response(JSON.stringify({ error: 'Usuário não encontrado' }), {
        status: 404, headers: { 'Content-Type': 'application/json' }
      });
    }
    // Setar custom claim via accounts:update
    const r2 = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:update`,
      {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ localId: uid, customAttributes: JSON.stringify({ admin: true }) })
      }
    );
    const d2 = await r2.json();
    if (d2.error) {
      return new Response(JSON.stringify({ error: d2.error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ ok: true, uid, email: body.email, claims: { admin: true } }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

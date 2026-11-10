/**
 * Finanvô — Worker de Indicações
 *
 * Roda como Cron Trigger diário + endpoint manual.
 * Verifica indicações com 7+ dias de uso real e aplica bônus ao indicador.
 *
 * Deploy: wrangler deploy
 * Cron:   wrangler deploy (com cron no wrangler.toml)
 *
 * Secrets necessários (wrangler secret put <nome>):
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY
 */

export default {
  // ── Cron diário (configurado no wrangler.toml) ──────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processarIndicacoesPendentes(env));
  },

  // ── Endpoint manual (POST /processar) para testes/forçar ────────
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': 'https://appfinanvo.com.br',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      }});
    }

    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const url = new URL(request.url);

    // Endpoint /processar — requer secret de admin
    if (url.pathname === '/processar') {
      const authHeader = request.headers.get('Authorization') || '';
      if (!env.ADMIN_SECRET || authHeader !== 'Bearer ' + env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      const resultado = await processarIndicacoesPendentes(env);
      return new Response(JSON.stringify(resultado), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not found', { status: 404 });
  }
};

// ── Processamento principal ──────────────────────────────────────────
async function processarIndicacoesPendentes(env) {
  const token = await getToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;
  const BONUS_DIAS = 30; // dias de bônus por indicação ativada
  const DIAS_USO_MINIMO = 7;

  // Buscar todas as indicações com ativo:false
  const queryBody = {
    structuredQuery: {
      from: [{ collectionId: 'indicacoes', allDescendants: false }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'ativo' },
          op: 'EQUAL',
          value: { booleanValue: false }
        }
      },
      limit: 500
    }
  };

  const qr = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`,
    { method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(queryBody) }
  );
  const rows = await qr.json();

  let ativadas = 0;
  const erros = [];

  for (const row of rows) {
    const doc = row.document;
    if (!doc) continue;

    const fields = doc.fields || {};
    const indicadoUid    = fields.indicadoUid?.stringValue;
    const indicadorUid   = fields.indicadorUid?.stringValue;
    const codigoIndicador = fields.codigoIndicador?.stringValue;

    if (!indicadoUid) continue;

    try {
      // Verificar dias de acesso do indicado
      const snapInd = await fetch(
        `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${indicadoUid}`,
        { headers: { 'Authorization': 'Bearer ' + token } }
      );
      if (snapInd.status !== 200) continue;
      const indData = await snapInd.json();
      const diasAcesso = indData.fields?.diasAcesso?.arrayValue?.values?.length || 0;

      // Fallback: verificar data de cadastro (campo criado)
      let elegivel = diasAcesso >= DIAS_USO_MINIMO;
      if (!elegivel) {
        const criado = indData.fields?.criado?.stringValue || indData.fields?.criado?.timestampValue;
        if (criado) {
          const diasDesde = (Date.now() - new Date(criado).getTime()) / 864e5;
          elegivel = diasDesde >= DIAS_USO_MINIMO;
        }
      }

      if (!elegivel) continue;

      // Marcar indicação como ativa
      const docName = doc.name;
      await fetch(`${docName}?updateMask.fieldPaths=ativo&updateMask.fieldPaths=dataAtivacao`, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: {
          ativo: { booleanValue: true },
          dataAtivacao: { stringValue: new Date().toISOString() }
        }})
      });

      // Aplicar bônus ao indicador (se tivermos o UID)
      const uidIndicador = indicadorUid || await buscarUidPorCodigo(env, token, projectId, codigoIndicador);
      if (uidIndicador) {
        await aplicarBonusIndicador(env, token, projectId, uidIndicador, BONUS_DIAS);
      }

      ativadas++;
      console.log(`[indicacoes] Ativada: indicado=${indicadoUid} dias=${diasAcesso}`);
    } catch(e) {
      erros.push({ indicadoUid, erro: e.message });
      console.error('[indicacoes] Erro:', indicadoUid, e.message);
    }
  }

  return { ativadas, erros: erros.length, detalhes: erros };
}

// ── Busca UID do indicador pelo código de indicação ──────────────────
async function buscarUidPorCodigo(env, token, projectId, codigo) {
  if (!codigo) return null;
  try {
    const qr = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`,
      { method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ structuredQuery: {
          from: [{ collectionId: 'users' }],
          where: { fieldFilter: {
            field: { fieldPath: 'codigoIndicacao' },
            op: 'EQUAL',
            value: { stringValue: codigo }
          }},
          limit: 1
        }}) }
    );
    const rows = await qr.json();
    const docName = rows[0]?.document?.name;
    if (!docName) return null;
    return docName.split('/').pop();
  } catch { return null; }
}

// ── Aplica bônus de dias ao indicador ───────────────────────────────
async function aplicarBonusIndicador(env, token, projectId, uid, diasBonus) {
  // Lê o valor atual de bonusDias
  const snap = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}`,
    { headers: { 'Authorization': 'Bearer ' + token } }
  );
  const data = await snap.json();
  const bonusAtual = parseInt(data.fields?.bonusDias?.integerValue || '0');
  const novoBonus  = bonusAtual + diasBonus;

  await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}?updateMask.fieldPaths=bonusDias&updateMask.fieldPaths=bonusDiasAtualizadoEm`,
    { method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        bonusDias: { integerValue: String(novoBonus) },
        bonusDiasAtualizadoEm: { stringValue: new Date().toISOString() }
      }}) }
  );
}

// ── JWT / Service Account (igual ao hotmart-webhook/worker.js) ───────
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

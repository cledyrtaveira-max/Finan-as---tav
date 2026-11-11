/**
 * Finanvô — IA Worker
 * Recebe dados financeiros do mês e retorna análise inteligente
 * usando Cloudflare AI (Workers AI — llama-3.1-8b-instruct, grátis até 10k req/dia)
 *
 * Deploy: wrangler deploy
 * URL: https://finanvo-ia.cledyrtaveira.workers.dev
 */

// Service Account FCM — carregada via variável de ambiente segura
// Configure com: wrangler secret put FCM_SA  (cole o JSON quando solicitado)
// NUNCA coloque a chave privada diretamente no código!
const FCM_SA = typeof FCM_SA_SECRET !== 'undefined' ? JSON.parse(FCM_SA_SECRET) : null;

// Origens autorizadas (domínio do app + GitHub Pages para dev)
const ORIGENS_PERMITIDAS = [
  'https://appfinanvo.com.br',
  'https://cledyrtaveira-max.github.io',
];

function corsHeaders(origin) {
  const permitida = ORIGENS_PERMITIDAS.some(o => (origin || '').startsWith(o));
  return {
    'Access-Control-Allow-Origin': permitida ? origin : ORIGENS_PERMITIDAS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
  };
}

// Planos com acesso à IA Worker (gratuito = análise local apenas)
const PLANOS_IA = ['pro', 'familia', 'premium'];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    // Verificar origem (bloqueia chamadas fora do app)
    const origemOk = ORIGENS_PERMITIDAS.some(o => origin.startsWith(o));
    if (!origemOk && env.ENFORCE_ORIGIN !== 'false') {
      return new Response('Forbidden', { status: 403, headers: cors });
    }

    // Declarar url aqui — usado por todas as rotas abaixo
    const url = new URL(request.url);

    // Rota push — envia FCM para lista de tokens (admin only)
    if (url.pathname === '/push-notify') {
      let body;
      try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
      const { tokens, title, body: msgBody, adminKey, adminPin, serviceAccount } = body;
      // Chave de admin (PEN-03: dupla verificação — chave + PIN)
      if (!env.ADMIN_PUSH_KEY || adminKey !== env.ADMIN_PUSH_KEY) {
        return new Response('Forbidden', { status: 403, headers: cors });
      }
      // PEN-03: Validar PIN de admin server-side
      if (env.ADMIN_PIN) {
        if (!adminPin) {
          return new Response(JSON.stringify({ error: 'PIN obrigatório' }), { status: 403, headers: cors });
        }
        const pinHash = await hashSHA256(adminPin);
        const expectedHash = await hashSHA256(env.ADMIN_PIN);
        if (pinHash !== expectedHash) {
          return new Response(JSON.stringify({ error: 'PIN inválido' }), { status: 403, headers: cors });
        }
      }
      if (!tokens?.length || !title) return new Response('Missing tokens or title', { status: 400, headers: cors });

      // Service Account: embutida no worker (FCM_SA) ou pode vir no body
      const sa = serviceAccount || FCM_SA;

      // Gerar JWT para OAuth2 do Google
      const accessToken = await getGoogleAccessToken(sa);
      const projectId = sa.project_id;

      const results = { success: 0, failure: 0 };
      // FCM v1 envia uma mensagem por vez (ou batch via multicast não está em v1 ainda)
      // Usamos Promise.all com limite de 50 paralelos
      const BATCH = 50;
      for (let i = 0; i < tokens.length; i += BATCH) {
        const slice = tokens.slice(i, i + BATCH);
        await Promise.all(slice.map(async token => {
          try {
            const r = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: {
                  token,
                  notification: { title, body: msgBody || '' },
                  webpush: { notification: { icon: '/logo.svg' }, fcm_options: { link: '/finapp.html' } }
                }
              })
            });
            if (r.ok) results.success++; else results.failure++;
          } catch { results.failure++; }
        }));
      }
      return new Response(JSON.stringify(results), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // Rota de suporte/chat — requer usuário autenticado
    if (url.pathname === '/chat') {
      let body;
      try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }

      // SEC-05: Verificar Firebase ID token
      const chatToken = body.idToken || request.headers.get('Authorization')?.replace('Bearer ', '');
      if (env.FIREBASE_PROJECT_ID && chatToken) {
        const uid = await verifyFirebaseToken(chatToken, env.FIREBASE_PROJECT_ID);
        if (!uid) {
          return new Response(JSON.stringify({ error: 'Não autorizado' }), { status: 401, headers: cors });
        }
      }

      const { pergunta, historico = [] } = body;
      if (!pergunta) return new Response('Missing pergunta', { status: 400 });

      const ai = env.AI;
      if (!ai) return new Response(JSON.stringify({ resposta: respostaFallback(pergunta) }), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      });

      const msgs = [
        { role: 'system', content: `Você é o assistente virtual do Finanvô, app brasileiro de controle financeiro familiar.
Responda perguntas sobre o app de forma simpática, direta e em português brasileiro informal.
Informações do app:
- Plano Grátis: dashboard, despesas fixas, login, PWA — R$0
- Plano Básico: + metas, PDF, gráficos — R$12,99/mês ou R$149/ano
- Plano Família: + multi-usuário (6 pessoas), lembretes, WhatsApp — R$22,99/mês ou R$249/ano
- Plano Premium: + IA, projeções, VIP — R$32,99/mês ou R$349/ano
- Teste grátis: 7 dias em qualquer plano pago
- Pagamento: Hotmart (cartão, boleto, Pix)
- Cancelamento: a qualquer momento, sem multa
- Suporte humano: chat no site (appfinanvo.com.br)
- O app funciona offline e instala como app no celular (PWA)
Se não souber responder, diga que vai encaminhar para o suporte humano.
Responda em no máximo 3 frases curtas.` },
        ...historico.slice(-6),
        { role: 'user', content: pergunta }
      ];

      try {
        const res = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: msgs, max_tokens: 200, temperature: 0.5
        });
        return new Response(JSON.stringify({ resposta: res.response || respostaFallback(pergunta) }), {
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      } catch(e) {
        return new Response(JSON.stringify({ resposta: respostaFallback(pergunta) }), {
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
    }

    let body;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }

    // SEC-05 + C5 FIX: Verificar Firebase ID token e buscar plano real do Firestore.
    // plano vindo do body do cliente é SEMPRE ignorado — evita escalação de privilégio.
    const idToken = body.idToken || request.headers.get('Authorization')?.replace('Bearer ', '');
    let verifiedUid = null;
    if (env.FIREBASE_PROJECT_ID && idToken) {
      verifiedUid = await verifyFirebaseToken(idToken, env.FIREBASE_PROJECT_ID);
      if (!verifiedUid) {
        return new Response(JSON.stringify({ error: 'Não autorizado' }), { status: 401, headers: cors });
      }
    }

    const { mes, ano, entradas, saidas, saldo, categorias, lancamentos } = body;

    // C5 FIX: buscar plano real do Firestore via Service Account (nunca via body do cliente)
    let plano = 'gratuito';
    if (verifiedUid && env.FIREBASE_PROJECT_ID) {
      try {
        const saToken = await getToken(env);
        const docR = await fetch(
          `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${verifiedUid}`,
          { headers: { 'Authorization': 'Bearer ' + saToken } }
        );
        if (docR.ok) {
          const docData = await docR.json();
          plano = docData.fields?.plano?.stringValue || 'gratuito';
        }
      } catch (_) { /* fallback: gratuito */ }
    }

    // Plano gratuito → análise local apenas (sem consumir cota de IA)
    if (!PLANOS_IA.includes(plano)) {
      return new Response(JSON.stringify(analisarLocal({ ...body, plano })), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // Monta contexto financeiro para o modelo
    const catResume = (categorias || [])
      .sort((a, b) => b.val - a.val)
      .slice(0, 8)
      .map(c => `  - ${c.nome}: R$${c.val.toFixed(2)}`)
      .join('\n');

    const pct = entradas > 0 ? Math.round((saidas / entradas) * 100) : 0;
    const status = saldo >= 0 ? 'positivo' : 'negativo';

    // M43: contexto completo enviado pelo app (campos opcionais — apps antigos não enviam)
    const n = v => (Number(v) || 0).toFixed(2);
    const hist6 = Array.isArray(body.historico6m) ? body.historico6m.slice(-6)
      .map(h => `  - ${String(h.mes).slice(0, 12)}/${Number(h.ano) || ''}: entradas R$${n(h.entradas)}, saídas R$${n(h.saidas)}, saldo R$${n(h.saldo)}`).join('\n') : '';
    const dividasTxt = Array.isArray(body.dividas) ? body.dividas.slice(0, 6)
      .map(d => `  - ${String(d.nome).slice(0, 40)}: saldo R$${n(d.saldo)}, juros ${Number(d.taxa) || 0}% ao mês`).join('\n') : '';
    const objetivosTxt = Array.isArray(body.objetivos) ? body.objetivos.slice(0, 5)
      .map(o => `  - ${String(o.nome).slice(0, 40)}: faltam R$${n(o.falta)}`).join('\n') : '';
    const temContexto = body.acumulado !== undefined;
    const contexto = temContexto ? `
SITUAÇÃO GERAL:
- Saldo acumulado (meses anteriores + este mês): R$${n(body.acumulado)}
- Saldo que veio dos meses anteriores: R$${n(body.saldoAnterior)}
- Gasto médio mensal: R$${n(body.despMedia)}
- Sobra média mensal: R$${n(body.sobraMedia)}
- Total já investido: R$${n(body.investido)}
- Parcelas de dívida pagas no mês: R$${n(body.dividasMes)}

ÚLTIMOS 6 MESES:
${hist6 || '(sem dados)'}

DÍVIDAS EM ABERTO:
${dividasTxt || '(nenhuma)'}

OBJETIVOS EM ABERTO:
${objetivosTxt || '(nenhum)'}

REGRAS PARA OS INSIGHTS:
- Se o saldo acumulado for positivo, diga claramente quanto está sobrando e que esse dinheiro pode ser aplicado.
- Prioridade para a sobra: 1) quitar dívida com juros de 2% ao mês ou mais; 2) completar reserva de emergência de 6 meses de gastos; 3) objetivos; 4) investimento de longo prazo.
- Compare o mês com os meses anteriores (melhorou ou piorou).
- Use os números reais acima. Não invente valores nem prometa rentabilidade.
` : '';

    const prompt = `Você é o consultor financeiro do app Finanvô, um aplicativo brasileiro de controle financeiro familiar.
Analise os dados financeiros de ${mes}/${ano} e forneça insights práticos em português brasileiro informal.

DADOS DO MÊS:
- Entradas: R$${(entradas||0).toFixed(2)}
- Saídas: R$${(saidas||0).toFixed(2)}
- Saldo: R$${(saldo||0).toFixed(2)} (${status})
- % gasto da renda: ${pct}%
- Plano do usuário: ${plano || 'gratuito'}

GASTOS POR CATEGORIA:
${catResume || '(sem dados)'}
${contexto}
Responda em JSON com exatamente este formato (sem markdown, só JSON puro):
{
  "semaforo": "verde" | "amarelo" | "vermelho",
  "titulo": "frase curta resumindo o mês (máx 8 palavras)",
  "resumo": "parágrafo de 2-3 frases sobre o mês, tom amigável",
  "insights": [
    "insight 1 específico (máx 15 palavras)",
    "insight 2 específico (máx 15 palavras)",
    "insight 3 específico (máx 15 palavras)",
    "insight 4 sobre o que fazer com o dinheiro que sobra, se houver (máx 25 palavras)"
  ],
  "alerta": "alerta principal se houver problema, ou null",
  "dica": "dica prática e acionável para o próximo mês (máx 20 palavras)"
}`;

    // Cache de 24h por usuário+mês — evita rechamadas desnecessárias
    // C5 FIX: usar verifiedUid (do token), nunca body.uid (pode ser forjado)
    const uid = verifiedUid || null;
    const cacheKey = uid
      ? `finanvo-ia-${uid}-${body.ano}-${body.mes}`
      : null;

    if (cacheKey) {
      try {
        const cached = await caches.default.match(new Request(`https://cache.finanvo/${cacheKey}`));
        if (cached) {
          const data = await cached.json();
          return new Response(JSON.stringify({ ...data, _cache: true }), {
            headers: { ...cors, 'Content-Type': 'application/json' }
          });
        }
      } catch (_) {}
    }

    try {
      // Usa Workers AI (gratuito) — modelo leve e rápido
      const ai = env.AI;

      if (!ai) {
        return new Response(JSON.stringify(analisarLocal(body)), {
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: 'Você é um consultor financeiro brasileiro. Responda SEMPRE em JSON puro, sem markdown.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 500,
        temperature: 0.3,
      });

      let texto = response.response || '';
      // Extrai JSON da resposta (às vezes o modelo adiciona texto extra)
      const match = texto.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('JSON não encontrado na resposta');

      const analise = JSON.parse(match[0]);

      // Salva no cache por 24h
      if (cacheKey) {
        try {
          const ttl = 60 * 60 * 24; // 24 horas
          await caches.default.put(
            new Request(`https://cache.finanvo/${cacheKey}`),
            new Response(JSON.stringify(analise), {
              headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` }
            })
          );
        } catch (_) {}
      }

      return new Response(JSON.stringify(analise), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      });

    } catch (e) {
      console.error('AI error:', e.message);
      return new Response(JSON.stringify(analisarLocal(body)), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
  }
};

// ── SHA-256 hash helper (para validação de PIN) ─────────────────────
async function hashSHA256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Verificar Firebase ID Token (SEC-05) ────────────────────────────
// Usa a Firebase Auth REST API para validar o token sem SDK
async function verifyFirebaseToken(idToken, projectId) {
  try {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${projectId}`;
    // Verificação via tokenInfo endpoint do Google
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
    if (!r.ok) return null;
    const data = await r.json();
    // Verifica se o token é do projeto correto
    if (data.aud !== projectId && !data.aud?.includes(projectId)) return null;
    return data.sub || data.user_id || null;
  } catch {
    return null;
  }
}

// ── Google OAuth2 JWT para FCM v1 ───────────────────────────────────
async function getGoogleAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const enc = v => btoa(JSON.stringify(v)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const signingInput = `${enc(header)}.${enc(payload)}`;

  // Importar chave privada RSA
  const pemBody = sa.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const jwt = `${signingInput}.${sigB64}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const data = await resp.json();
  return data.access_token;
}

// ── Respostas de fallback para suporte ──────────────────────────────
function respostaFallback(pergunta) {
  const p = (pergunta || '').toLowerCase();
  if (p.includes('plano') || p.includes('preço') || p.includes('preco') || p.includes('valor') || p.includes('custa')) {
    return 'Temos 4 planos: Grátis (R$0), Básico (R$12,99/mês), Família (R$22,99/mês) e Premium (R$32,99/mês). Todos com 7 dias de teste grátis! 😊';
  }
  if (p.includes('cancel') || p.includes('suspender')) {
    return 'Você pode cancelar a qualquer momento, sem multa. Basta acessar suas configurações de pagamento na Hotmart.';
  }
  if (p.includes('pix') || p.includes('boleto') || p.includes('pagament') || p.includes('cartão') || p.includes('cartao')) {
    return 'Aceitamos cartão de crédito, boleto bancário e Pix via Hotmart. O pagamento é 100% seguro!';
  }
  if (p.includes('família') || p.includes('familia') || p.includes('compartilh')) {
    return 'O Plano Família permite até 6 usuários na mesma conta! Ideal para controlar as finanças de toda a família.';
  }
  if (p.includes('ia') || p.includes('inteligência') || p.includes('analise') || p.includes('análise')) {
    return 'A análise com IA está disponível no Plano Premium. Ela analisa seus gastos e dá dicas personalizadas todo mês!';
  }
  if (p.includes('celular') || p.includes('app') || p.includes('instalar') || p.includes('pwa')) {
    return 'O Finanvô funciona no celular como um app! Acesse pelo navegador e toque em "Adicionar à tela inicial" para instalar. Funciona offline também!';
  }
  if (p.includes('senha') || p.includes('login') || p.includes('entrar') || p.includes('acess')) {
    return 'Se tiver problemas pra acessar, tente redefinir sua senha pelo botão "Esqueci a senha" na tela de login. Precisando de mais ajuda, fala com a gente!';
  }
  return 'Boa pergunta! Vou encaminhar pro nosso suporte humano pra te responder certinho. Clique em "Falar com suporte" abaixo! 😊';
}

// ── Análise local por regras (fallback sem IA) ──────────────────────
function analisarLocal({ entradas = 0, saidas = 0, saldo = 0, categorias = [], mes, ano }) {
  const pct = entradas > 0 ? Math.round((saidas / entradas) * 100) : 0;

  let semaforo = 'verde';
  if (pct > 85) semaforo = 'vermelho';
  else if (pct > 65) semaforo = 'amarelo';

  // Maior categoria de gasto
  const cats = (categorias || []).sort((a, b) => b.val - a.val);
  const maisCara = cats[0];

  const insights = [];
  if (maisCara) insights.push(`Seu maior gasto foi ${maisCara.nome}: R$${maisCara.val.toFixed(2)}`);
  if (pct > 85) insights.push(`Você gastou ${pct}% da sua renda — atenção com os limites`);
  else if (pct <= 60) insights.push(`Ótimo! Você usou apenas ${pct}% da renda`);
  else insights.push(`Você usou ${pct}% da renda — ainda dentro do controle`);
  if (saldo > 0) insights.push(`Sobrou R$${saldo.toFixed(2)} — considere guardar ou investir`);
  else if (saldo < 0) insights.push(`Saldo negativo: R$${Math.abs(saldo).toFixed(2)} a mais do que entrou`);

  const titulos = {
    verde: 'Mês equilibrado! 🟢',
    amarelo: 'Atenção com os gastos 🟡',
    vermelho: 'Mês no vermelho! 🔴'
  };

  const dicas = {
    verde: 'Continue assim! Tente guardar pelo menos 10% da renda no próximo mês.',
    amarelo: `Reduza gastos em ${maisCara ? maisCara.nome : 'categorias variáveis'} para voltar ao azul.`,
    vermelho: 'Identifique gastos desnecessários e corte pelo menos um no próximo mês.'
  };

  return {
    semaforo,
    titulo: titulos[semaforo],
    resumo: `Em ${mes}/${ano} você teve R$${entradas.toFixed(2)} de entradas e R$${saidas.toFixed(2)} de saídas, com saldo ${saldo >= 0 ? 'positivo' : 'negativo'} de R$${Math.abs(saldo).toFixed(2)}.`,
    insights: insights.slice(0, 3),
    alerta: semaforo === 'vermelho' ? `Gastos acima da renda em R$${Math.abs(saldo).toFixed(2)}` : null,
    dica: dicas[semaforo]
  };
}

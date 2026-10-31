/**
 * Finanvô — IA Worker
 * Recebe dados financeiros do mês e retorna análise inteligente
 * usando Cloudflare AI (Workers AI — llama-3.1-8b-instruct, grátis até 10k req/dia)
 *
 * Deploy: wrangler deploy
 * URL: https://finanvo-ia.cledyrtaveira.workers.dev
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    let body;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }

    const { mes, ano, entradas, saidas, saldo, categorias, lancamentos, plano } = body;

    // Monta contexto financeiro para o modelo
    const catResume = (categorias || [])
      .sort((a, b) => b.val - a.val)
      .slice(0, 8)
      .map(c => `  - ${c.nome}: R$${c.val.toFixed(2)}`)
      .join('\n');

    const pct = entradas > 0 ? Math.round((saidas / entradas) * 100) : 0;
    const status = saldo >= 0 ? 'positivo' : 'negativo';

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

Responda em JSON com exatamente este formato (sem markdown, só JSON puro):
{
  "semaforo": "verde" | "amarelo" | "vermelho",
  "titulo": "frase curta resumindo o mês (máx 8 palavras)",
  "resumo": "parágrafo de 2-3 frases sobre o mês, tom amigável",
  "insights": [
    "insight 1 específico (máx 15 palavras)",
    "insight 2 específico (máx 15 palavras)",
    "insight 3 específico (máx 15 palavras)"
  ],
  "alerta": "alerta principal se houver problema, ou null",
  "dica": "dica prática e acionável para o próximo mês (máx 20 palavras)"
}`;

    try {
      // Usa Workers AI (gratuito) — modelo leve e rápido
      const ai = env.AI;

      if (!ai) {
        // Fallback: análise local baseada em regras (sem AI)
        return new Response(JSON.stringify(analisarLocal(body)), {
          headers: { ...CORS, 'Content-Type': 'application/json' }
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
      return new Response(JSON.stringify(analise), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });

    } catch (e) {
      console.error('AI error:', e.message);
      // Fallback com análise baseada em regras
      return new Response(JSON.stringify(analisarLocal(body)), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }
  }
};

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

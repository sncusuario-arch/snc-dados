/* ============================================================================
   SNC — Dashboard Executivo · Sistema Nacional de Cultura
   app.js — lógica de dados, agregações, gráficos e interações
   Nenhum dado fictício: todos os indicadores são calculados a partir
   da planilha carregada (base padrão embarcada ou upload do usuário).
   ============================================================================ */

(function () {
  "use strict";

  /* ---------------------------------------------------------------------
     1. CONSTANTES E METADADOS
     --------------------------------------------------------------------- */

  const UF_NOME = {
    AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia",
    CE: "Ceará", DF: "Distrito Federal", ES: "Espírito Santo", GO: "Goiás",
    MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul", MG: "Minas Gerais",
    PA: "Pará", PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí",
    RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RS: "Rio Grande do Sul",
    RO: "Rondônia", RR: "Roraima", SC: "Santa Catarina", SP: "São Paulo",
    SE: "Sergipe", TO: "Tocantins"
  };

  // Cartograma em grade (tile-grid) — posições aproximadas [col, row]
  const UF_TILES = {
    RR: [3, 0], AP: [5, 0],
    AM: [1, 1], PA: [4, 1], MA: [6, 1],
    AC: [0, 2], RO: [1, 2], TO: [5, 2], PI: [6, 2], CE: [7, 2], RN: [8, 2],
    MT: [2, 3], DF: [4, 3], PE: [7, 3], PB: [8, 3],
    MS: [2, 5], GO: [4, 4], BA: [6, 4], SE: [7, 4], AL: [8, 4],
    MG: [5, 5], ES: [6, 5],
    SP: [4, 6], RJ: [6, 6],
    PR: [4, 7],
    SC: [4, 8],
    RS: [3, 9]
  };

  const COMPONENT_KEYS = ["sis", "con", "fun", "pla", "org"];
  const COMPONENT_LABELS = {
    sis: "Sistema", con: "Conselho", fun: "Fundo", pla: "Plano", org: "Órgão Gestor"
  };
  const COMPONENT_COLORS = {
    sis: "#2f6feb", con: "#0ea5e9", fun: "#16a34a", pla: "#f59e0b", org: "#7c3aed"
  };

  const SCALE_COLORS = [
    { min: 80, color: "#0a6e3a", label: "Acima de 80%" },
    { min: 60, color: "#3fae6b", label: "60% a 80%" },
    { min: 40, color: "#f2c94c", label: "40% a 60%" },
    { min: 20, color: "#f08c3a", label: "20% a 40%" },
    { min: -1, color: "#dc2626", label: "Abaixo de 20%" }
  ];

  const GAUGE_BANDS = [
    { from: 0, to: 1, color: "#dc2626", label: "Crítico" },
    { from: 1, to: 2, color: "#f08c3a", label: "Muito Baixo" },
    { from: 2, to: 3, color: "#f2c94c", label: "Baixo" },
    { from: 3, to: 4, color: "#3fae6b", label: "Médio" },
    { from: 4, to: 5, color: "#0a6e3a", label: "Avançado" }
  ];

  function classifyMaturity(v) {
    if (v >= 5) return { label: "Completo", color: "#065f33" };
    if (v >= 4) return { label: "Avançado", color: "#0a6e3a" };
    if (v >= 3) return { label: "Médio", color: "#3fae6b" };
    if (v >= 2) return { label: "Baixo", color: "#f2c94c" };
    if (v >= 1) return { label: "Muito Baixo", color: "#f08c3a" };
    return { label: "Crítico", color: "#dc2626" };
  }

  function colorForPct(pct) {
    for (const band of SCALE_COLORS) {
      if (pct >= band.min) return band.color;
    }
    return "#dc2626";
  }

  function fmtInt(n) {
    return (n || 0).toLocaleString("pt-BR");
  }
  function fmtPct(n, digits) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return n.toLocaleString("pt-BR", { minimumFractionDigits: digits || 1, maximumFractionDigits: digits || 1 }) + "%";
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    const parts = iso.split("-");
    if (parts.length !== 3) return iso;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }
  function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------------------------------------------------------------------
     2. ESTADO GLOBAL DA APLICAÇÃO
     --------------------------------------------------------------------- */

  const STATE = {
    raw: [],                 // dataset canônico completo
    sourceLabel: "Base padrão SNC (planilha oficial carregada)",
    currentView: "dashboard",
    filters: { uf: "", regiao: "", adesao: "", periodo: "", search: "" },
    table: { sortKey: "idx", sortDir: "desc", page: 1, pageSize: 25, search: "" },
    mapLabels: true,
    charts: {},
    activeReportKind: null    // "executivo" | "municipio" | "estado" | "checklist" | "contatos" | null
  };

  /* ---------------------------------------------------------------------
     3. NORMALIZAÇÃO DE DADOS (upload de planilha externa)
     --------------------------------------------------------------------- */

  // candidatos de cabeçalho (case-insensitive, busca por inclusão de termo)
  const HEADER_CANDIDATES = {
    m: ["ente federado", "município", "municipio", "nome do município", "cidade"],
    uf: ["uf", "estado"],
    reg: ["região", "regiao"],
    ibge: ["cod.ibge", "código ibge", "codigo ibge", "ibge"],
    pop: ["população", "populacao"],
    sit: ["situação da lei do sistema de cultura"], // fallback abaixo cobre "situação" genérica
    sitGeneric: ["situação", "situacao", "adesão", "adesao"],
    dtAd: ["data adesão", "data adesao", "data de adesão"],
    sis: ["situação da lei do sistema de cultura", "sistema"],
    con: ["situação da lei do conselho", "conselho"],
    fun: ["situação da lei do fundo", "fundo"],
    pla: ["situação do plano de cultura", "plano"],
    org: ["situação do órgão gestor", "situação do orgao gestor", "órgão gestor", "orgao gestor"],
    upd: ["última atualização", "ultima atualizacao", "última atualizacao"],
    pt: ["situação do plano de trabalho"],
    acf: ["acf incluído", "acf incluido"],
    vig: ["último ano de vigência do plano de cultura", "ultimo ano de vigencia"],
    mon: ["plano monitorado"],
    pref: ["prefeito"],
    cad: ["cadastrador"],
    gestor: ["gestor de cultura"]
  };

  function findHeader(headers, candidates) {
    const lower = headers.map((h) => (h || "").toString().toLowerCase().trim());
    for (const cand of candidates) {
      const idx = lower.findIndex((h) => h === cand);
      if (idx >= 0) return headers[idx];
    }
    for (const cand of candidates) {
      const idx = lower.findIndex((h) => h.includes(cand));
      if (idx >= 0) return headers[idx];
    }
    return null;
  }

  function truthyDone(v) {
    if (v === null || v === undefined) return 0;
    const s = String(v).trim().toLowerCase();
    return (s === "concluída" || s === "concluida" || s === "sim" || s === "1" || s === "true" || s === "yes") ? 1 : 0;
  }

  function parseBrDate(v) {
    if (!v) return null;
    const s = String(v).trim();
    const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return null;
  }

  function normalizeUploadedRows(sheetRows) {
    if (!sheetRows || !sheetRows.length) return [];
    const headers = Object.keys(sheetRows[0]);
    const map = {};
    for (const key of Object.keys(HEADER_CANDIDATES)) {
      map[key] = findHeader(headers, HEADER_CANDIDATES[key]);
    }
    const mCol = map.m, ufCol = map.uf;
    if (!mCol || !ufCol) {
      throw new Error("Não foi possível identificar as colunas de Município e UF na planilha.");
    }

    const out = [];
    for (const r of sheetRows) {
      const ufRaw = (r[ufCol] || "").toString().trim().toUpperCase();
      if (!ufRaw || ufRaw.length > 2) continue; // ignora linhas de cabeçalho duplicado etc.
      const nome = (r[mCol] || "").toString().trim();
      if (!nome) continue;
      // ignora linhas que representam o próprio Estado (entes estaduais), já que o
      // dashboard trabalha em nível municipal
      if (/^estado de /i.test(nome) || nome.toLowerCase() === "distrito federal" && false) {
        // (Distrito Federal é mantido como ente municipal equivalente)
      }
      if (/^estado de /i.test(nome)) continue;

      const sitVal = map.sitGeneric ? r[map.sitGeneric] : (map.sis ? r[map.sis] : null);
      const sitStr = (sitVal || "").toString().trim();
      const semAdesaoTokens = ["nao possui adesão", "não possui adesão", "nao possui adesao", "não", "nao", "n", "0"];
      const aderiu = sitStr ? !semAdesaoTokens.includes(sitStr.toLowerCase()) : true;

      const sis = map.sis ? truthyDone(r[map.sis]) : 0;
      const con = map.con ? truthyDone(r[map.con]) : 0;
      const fun = map.fun ? truthyDone(r[map.fun]) : 0;
      const pla = map.pla ? truthyDone(r[map.pla]) : 0;
      const org = map.org ? truthyDone(r[map.org]) : 0;
      const idx = aderiu ? (sis + con + fun + pla + org) : 0;

      let vigYear = null;
      if (map.vig) {
        const n = parseInt(r[map.vig], 10);
        if (!isNaN(n)) vigYear = n;
      }

      out.push({
        m: nome,
        uf: ufRaw,
        reg: map.reg ? (r[map.reg] || "").toString().trim() : "",
        ibge: map.ibge ? parseInt(r[map.ibge], 10) || null : null,
        pop: map.pop ? parseInt(r[map.pop], 10) || null : null,
        sit: aderiu ? (sitStr || "Publicado no DOU") : "Não possui adesão",
        ad: aderiu,
        dtAd: aderiu && map.dtAd ? parseBrDate(r[map.dtAd]) : null,
        sis, con, fun, pla, org, idx,
        upd: map.upd ? parseBrDate(r[map.upd]) : null,
        pt: map.pt ? (r[map.pt] || null) : null,
        acf: map.acf ? truthyDone(r[map.acf]) : 0,
        vig: vigYear,
        venc: (pla === 1 && vigYear !== null && vigYear < new Date().getFullYear()) ? 1 : 0,
        mon: map.mon ? (String(r[map.mon] || "").toLowerCase().startsWith("sim") ? 1 : 0) : 0,
        pref: map.pref ? (r[map.pref] || null) : null,
        cad: map.cad ? (r[map.cad] || null) : null,
        gestor: map.gestor ? (r[map.gestor] || null) : null
      });
    }

    // preenche região ausente a partir da UF, se necessário
    const REGIAO_POR_UF = {
      AC: "Norte", AM: "Norte", AP: "Norte", PA: "Norte", RO: "Norte", RR: "Norte", TO: "Norte",
      AL: "Nordeste", BA: "Nordeste", CE: "Nordeste", MA: "Nordeste", PB: "Nordeste", PE: "Nordeste",
      PI: "Nordeste", RN: "Nordeste", SE: "Nordeste",
      DF: "Centro Oeste", GO: "Centro Oeste", MT: "Centro Oeste", MS: "Centro Oeste",
      ES: "Sudeste", MG: "Sudeste", RJ: "Sudeste", SP: "Sudeste",
      PR: "Sul", RS: "Sul", SC: "Sul"
    };
    out.forEach((r) => { if (!r.reg) r.reg = REGIAO_POR_UF[r.uf] || "—"; });

    return out;
  }

  /* ---------------------------------------------------------------------
     4. AGREGAÇÕES
     --------------------------------------------------------------------- */

  function applyFilters(data) {
    const f = STATE.filters;
    return data.filter((r) => {
      if (f.uf && r.uf !== f.uf) return false;
      if (f.regiao && r.reg !== f.regiao) return false;
      if (f.adesao === "com" && !r.ad) return false;
      if (f.adesao === "sem" && r.ad) return false;
      if (f.periodo && (!r.dtAd || !r.dtAd.startsWith(f.periodo))) return false;
      if (f.search) {
        const s = f.search.toLowerCase();
        if (!r.m.toLowerCase().includes(s)) return false;
      }
      return true;
    });
  }

  function computeAggregates(data) {
    const total = data.length;
    const aderidos = data.filter((r) => r.ad);
    const naoAderidos = total - aderidos.length;
    const pctAderidos = total ? (aderidos.length / total) * 100 : 0;

    let somaComponentesTotal = 0;
    data.forEach((r) => { somaComponentesTotal += r.idx; });
    const indiceNacional = total ? (somaComponentesTotal / (total * 5)) * 100 : 0;

    const mediaMaturidadeAderidos = aderidos.length
      ? aderidos.reduce((acc, r) => acc + r.idx, 0) / aderidos.length
      : 0;

    // por UF
    const byUF = {};
    data.forEach((r) => {
      if (!byUF[r.uf]) byUF[r.uf] = { uf: r.uf, total: 0, aderidos: 0, somaIdx: 0, sis: 0, con: 0, fun: 0, pla: 0, org: 0 };
      const b = byUF[r.uf];
      b.total++;
      if (r.ad) { b.aderidos++; b.somaIdx += r.idx; b.sis += r.sis; b.con += r.con; b.fun += r.fun; b.pla += r.pla; b.org += r.org; }
    });
    Object.values(byUF).forEach((b) => {
      b.pct = b.total ? (b.aderidos / b.total) * 100 : 0;
      b.idxMedio = b.aderidos ? b.somaIdx / b.aderidos : 0;
    });

    // por Região
    const byRegiao = {};
    data.forEach((r) => {
      const key = r.reg || "—";
      if (!byRegiao[key]) byRegiao[key] = { reg: key, total: 0, aderidos: 0 };
      byRegiao[key].total++;
      if (r.ad) byRegiao[key].aderidos++;
    });
    Object.values(byRegiao).forEach((b) => { b.pct = b.total ? (b.aderidos / b.total) * 100 : 0; });

    // evolução por ano de adesão
    const byYear = {};
    aderidos.forEach((r) => {
      if (!r.dtAd) return;
      const y = r.dtAd.slice(0, 4);
      byYear[y] = (byYear[y] || 0) + 1;
    });
    const years = Object.keys(byYear).sort();
    let acc = 0;
    const evolucao = years.map((y) => { acc += byYear[y]; return { year: y, novo: byYear[y], acumulado: acc }; });

    // componentes (taxa entre aderidos)
    const componentRates = {};
    COMPONENT_KEYS.forEach((k) => {
      const n = aderidos.reduce((s, r) => s + r[k], 0);
      componentRates[k] = { n, pct: aderidos.length ? (n / aderidos.length) * 100 : 0 };
    });

    // donut por índice de maturidade (entre aderidos)
    const donut = [0, 0, 0, 0, 0, 0];
    aderidos.forEach((r) => { donut[r.idx]++; });

    // alertas
    const semPlano = aderidos.filter((r) => r.pla === 0).length;
    const semConselho = aderidos.filter((r) => r.con === 0).length;
    const semFundo = aderidos.filter((r) => r.fun === 0).length;
    const planosVencidos = aderidos.filter((r) => r.venc === 1).length;
    const hoje = new Date();
    const doisAnosAtras = new Date(hoje.getFullYear() - 2, hoje.getMonth(), hoje.getDate());
    const semAtualizacao2anos = aderidos.filter((r) => {
      if (!r.upd) return false;
      const d = new Date(r.upd);
      return d < doisAnosAtras;
    }).length;
    const piorEstado = Object.keys(byUF).length > 1
      ? Object.values(byUF).filter((b) => b.total >= 3).sort((a, b) => a.pct - b.pct)[0]
      : null;

    // situação detalhada (DOU / aguardando / diligência)
    const situacaoCount = {};
    aderidos.forEach((r) => { situacaoCount[r.sit] = (situacaoCount[r.sit] || 0) + 1; });

    // planos: periodicidade e vigência
    const periodicidadeCount = {};
    const vigenciaCount = {};
    aderidos.filter((r) => r.pla === 1).forEach((r) => {
      if (r.vig) vigenciaCount[r.vig] = (vigenciaCount[r.vig] || 0) + 1;
    });

    return {
      total, aderidosCount: aderidos.length, naoAderidos, pctAderidos, indiceNacional, mediaMaturidadeAderidos,
      byUF, byRegiao, evolucao, componentRates, donut,
      alerts: { semPlano, semConselho, semFundo, planosVencidos, semAtualizacao2anos, piorEstado },
      situacaoCount, vigenciaCount,
      aderidosArr: aderidos
    };
  }

  // expõe para o restante do script (parte 2)
  window.__SNC = {
    STATE, UF_NOME, UF_TILES, COMPONENT_KEYS, COMPONENT_LABELS, COMPONENT_COLORS,
    SCALE_COLORS, GAUGE_BANDS, classifyMaturity, colorForPct,
    fmtInt, fmtPct, fmtDate, debounce, escapeHtml,
    normalizeUploadedRows, applyFilters, computeAggregates
  };
})();

/* ============================================================================
   PARTE 2 — Gráficos (Chart.js) e widgets visuais (KPIs, gauge, mapa)
   ============================================================================ */
(function () {
  "use strict";
  const S = window.__SNC;
  const { STATE, UF_NOME, UF_TILES, COMPONENT_KEYS, COMPONENT_LABELS, COMPONENT_COLORS,
    classifyMaturity, colorForPct, fmtInt, fmtPct, fmtDate, escapeHtml } = S;

  if (typeof Chart !== "undefined") {
    Chart.defaults.font.family = "'Inter', sans-serif";
    Chart.defaults.color = "#64748b";
    Chart.defaults.font.size = 11.5;
  } else {
    console.warn("Chart.js não foi carregado — gráficos não serão exibidos, mas o restante do painel continua funcionando.");
  }

  function destroyChart(id) {
    if (STATE.charts[id]) { STATE.charts[id].destroy(); delete STATE.charts[id]; }
  }
  function mkChart(id, config) {
    if (typeof Chart === "undefined") return null;
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    destroyChart(id);
    const chart = new Chart(canvas.getContext("2d"), config);
    STATE.charts[id] = chart;
    return chart;
  }

  /* ---------------- KPI cards ---------------- */
  function kpiCardHtml(opts) {
    return `
      <div class="card kpi-card">
        <div class="kpi-top">
          <div class="kpi-label">${opts.label}</div>
          <div class="kpi-icon ${opts.tone}">${opts.icon}</div>
        </div>
        <div class="kpi-value">${opts.value}</div>
        <div class="kpi-delta ${opts.deltaTone || "flat"}">${opts.delta || ""}</div>
      </div>`;
  }

  const ICONS = {
    municipios: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 21V8l6-4 6 4v13M16 21V11l4-2v12" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
    check: `<svg viewBox="0 0 24 24" fill="none"><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/></svg>`,
    x: `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/><path d="M9 9l6 6M15 9l-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    gauge: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 12L16 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4 14a8 8 0 1116 0" stroke="currentColor" stroke-width="1.8"/></svg>`,
    doc: `<svg viewBox="0 0 24 24" fill="none"><path d="M7 3h7l5 5v13H7V3z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`,
    flag: `<svg viewBox="0 0 24 24" fill="none"><path d="M5 21V4m0 1h12l-3 4 3 4H5" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`,
    bank: `<svg viewBox="0 0 24 24" fill="none"><path d="M3 10l9-6 9 6M5 10v9M19 10v9M9 10v9M15 10v9M3 21h18" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`,
    bell: `<svg viewBox="0 0 24 24" fill="none"><path d="M6 9a6 6 0 1112 0c0 4 1.5 6 2 7H4c.5-1 2-3 2-7z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9.5 19a2.5 2.5 0 005 0" stroke="currentColor" stroke-width="1.7"/></svg>`,
    clock: `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/><path d="M12 7v5l3.5 2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`
  };

  function renderKPIs(agg, aggBase, containerId) {
    // aggBase pode ser omitido (chamadas legadas) — nesse caso usa agg para tudo
    const base = aggBase || agg;
    const el = document.getElementById(containerId || "kpiRow");
    if (!el) return;
    const nUf = Object.keys(base.byUF).length;
    el.innerHTML = [
      kpiCardHtml({
        label: "Total de Municípios", value: fmtInt(base.total), tone: "blue", icon: ICONS.municipios,
        delta: `${fmtInt(nUf)} unidade${nUf === 1 ? "" : "s"} federativa${nUf === 1 ? "" : "s"}`, deltaTone: "flat"
      }),
      kpiCardHtml({
        label: "Municípios com Adesão", value: fmtInt(agg.aderidosCount), tone: "green", icon: ICONS.check,
        delta: `${fmtPct(base.total ? (agg.aderidosCount / base.total) * 100 : 0)} do total nacional`, deltaTone: "up"
      }),
      kpiCardHtml({
        label: "Municípios sem Adesão", value: fmtInt(base.total - agg.aderidosCount), tone: "red", icon: ICONS.x,
        delta: `${fmtPct(base.total ? ((base.total - agg.aderidosCount) / base.total) * 100 : 0)} do total nacional`, deltaTone: "down"
      }),
      kpiCardHtml({
        label: "Índice Nacional de Implementação", value: fmtPct(agg.indiceNacional), tone: "amber", icon: ICONS.gauge,
        delta: `Média dos 5 componentes do SNC`, deltaTone: "flat"
      })
    ].join("");
  }

  /* ---------------- Gráfico: evolução das adesões ---------------- */
  function buildEvolucaoConfig(agg) {
    return {
      type: "line",
      data: {
        labels: agg.evolucao.map((d) => d.year),
        datasets: [
          {
            label: "Adesões acumuladas",
            data: agg.evolucao.map((d) => d.acumulado),
            borderColor: "#2f6feb",
            backgroundColor: "rgba(47,111,235,0.08)",
            fill: true,
            tension: 0.35,
            pointRadius: 2.5,
            pointBackgroundColor: "#2f6feb",
            borderWidth: 2.4
          },
          {
            label: "Novas adesões no ano",
            data: agg.evolucao.map((d) => d.novo),
            borderColor: "#0ea5e9",
            backgroundColor: "rgba(14,165,233,0.0)",
            borderDash: [4, 3],
            tension: 0.35,
            pointRadius: 0,
            borderWidth: 1.6
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "bottom", labels: { boxWidth: 9, boxHeight: 9, usePointStyle: true, padding: 14 } } },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: "#eef2f7" }, beginAtZero: true }
        }
      }
    };
  }
  function renderEvolucaoChart(agg, canvasId) {
    mkChart(canvasId || "chartEvolucao", buildEvolucaoConfig(agg));
  }

  /* ---------------- Gráfico: adesões por estado (ranking, barras horizontais) ---------------- */
  function buildEstadosConfig(agg) {
    const arr = Object.values(agg.byUF).sort((a, b) => b.aderidos - a.aderidos).slice(0, 12);
    return {
      type: "bar",
      data: {
        labels: arr.map((b) => b.uf),
        datasets: [{
          label: "Municípios aderidos",
          data: arr.map((b) => b.aderidos),
          backgroundColor: arr.map((b) => colorForPct(b.pct)),
          borderRadius: 6,
          maxBarThickness: 16
        }]
      },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => `${fmtInt(ctx.parsed.x)} municípios (${fmtPct(arr[ctx.dataIndex].pct)})` } }
        },
        scales: { x: { grid: { color: "#eef2f7" } }, y: { grid: { display: false } } }
      }
    };
  }
  function renderEstadosChart(agg, canvasId) {
    mkChart(canvasId || "chartEstados", buildEstadosConfig(agg));
  }

  /* ---------------- Gráfico: componentes do SNC (barras) ---------------- */
  function renderComponentesChart(agg, canvasId) {
    mkChart(canvasId || "chartComponentes", {
      type: "bar",
      data: {
        labels: COMPONENT_KEYS.map((k) => COMPONENT_LABELS[k]),
        datasets: [{
          data: COMPONENT_KEYS.map((k) => agg.componentRates[k].pct),
          backgroundColor: COMPONENT_KEYS.map((k) => COMPONENT_COLORS[k]),
          borderRadius: 7,
          maxBarThickness: 38
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => `${fmtPct(ctx.parsed.y)} concluído (${fmtInt(COMPONENT_KEYS.map(k=>agg.componentRates[k].n)[ctx.dataIndex])} municípios)` } }
        },
        scales: {
          y: { beginAtZero: true, max: 100, grid: { color: "#eef2f7" }, ticks: { callback: (v) => v + "%" } },
          x: { grid: { display: false } }
        }
      }
    });
  }

  /* ---------------- Gráfico: donut maturidade ---------------- */
  function renderDonut(agg, canvasId, legendId) {
    const colors = ["#dc2626", "#f08c3a", "#f2c94c", "#3fae6b", "#0a6e3a", "#065f33"];
    const labels = ["0 componentes", "1 componente", "2 componentes", "3 componentes", "4 componentes", "5 componentes"];
    mkChart(canvasId || "chartDonut", {
      type: "doughnut",
      data: {
        labels,
        datasets: [{ data: agg.donut, backgroundColor: colors, borderWidth: 2, borderColor: "#fff" }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "68%",
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${labels[ctx.dataIndex]}: ${fmtInt(ctx.parsed)} municípios` } } }
      }
    });
    const legend = document.getElementById(legendId || "donutLegend");
    if (legend) {
      legend.innerHTML = labels.map((l, i) =>
        `<div class="legend-item"><span class="legend-swatch" style="background:${colors[i]}"></span>${l} <b style="color:var(--text)">${fmtInt(agg.donut[i])}</b></div>`
      ).join("");
    }
  }

  /* ---------------- Gauge (SVG nativo) ---------------- */
  function polarToCartesian(cx, cy, r, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
  }
  function describeArc(cx, cy, r, startAngle, endAngle) {
    const start = polarToCartesian(cx, cy, r, startAngle);
    const end = polarToCartesian(cx, cy, r, endAngle);
    const largeArcFlag = Math.abs(startAngle - endAngle) <= 180 ? 0 : 1;
    const sweepFlag = startAngle > endAngle ? 1 : 0;
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArcFlag} ${sweepFlag} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
  }

  function renderGauge(agg) {
    const svg = document.getElementById("gaugeSvg");
    if (!svg) return;
    const cx = 110, cy = 120, r = 90, thickness = 16;
    const value = agg.mediaMaturidadeAderidos;
    let html = "";
    S.GAUGE_BANDS.forEach((band) => {
      const startAngle = 180 - (band.from / 5) * 180;
      const endAngle = 180 - (band.to / 5) * 180;
      html += `<path d="${describeArc(cx, cy, r, startAngle, endAngle)}" stroke="${band.color}" stroke-width="${thickness}" fill="none" stroke-linecap="butt"/>`;
    });
    // ponteiro
    const needleAngle = 180 - (Math.min(value, 5) / 5) * 180;
    const tip = polarToCartesian(cx, cy, r - thickness - 6, needleAngle);
    html += `<line x1="${cx}" y1="${cy}" x2="${tip.x.toFixed(2)}" y2="${tip.y.toFixed(2)}" stroke="#0f172a" stroke-width="3" stroke-linecap="round"/>`;
    html += `<circle cx="${cx}" cy="${cy}" r="7" fill="#0f172a"/>`;
    // marcações 0..5
    for (let i = 0; i <= 5; i++) {
      const a = 180 - (i / 5) * 180;
      const p1 = polarToCartesian(cx, cy, r + thickness / 2 + 3, a);
      html += `<text x="${p1.x.toFixed(2)}" y="${p1.y.toFixed(2)}" font-size="9.5" fill="#94a3b8" text-anchor="middle" font-weight="600">${i}</text>`;
    }
    svg.innerHTML = html;

    const cls = classifyMaturity(value);
    document.getElementById("gaugeValue").textContent = value.toFixed(1);
    const classEl = document.getElementById("gaugeClass");
    classEl.textContent = cls.label;
    classEl.style.background = cls.color + "1a";
    classEl.style.color = cls.color;
  }

  /* ---------------- Mapa do Brasil (tile cartograma) ---------------- */
  function renderBrazilMap(svgId, panelId, agg) {
    const svg = document.getElementById(svgId);
    if (!svg) return;
    const cell = 32, gap = 4, originX = 18, originY = 8;
    let html = "";
    Object.keys(UF_TILES).forEach((uf) => {
      const [col, row] = UF_TILES[uf];
      const x = originX + col * (cell + gap);
      const y = originY + row * (cell + gap);
      const b = agg.byUF[uf];
      const pct = b ? b.pct : 0;
      const color = b ? colorForPct(pct) : "#e2e8f0";
      const ariaLabel = b
        ? `${UF_NOME[uf] || uf}: ${fmtInt(b.aderidos)} de ${fmtInt(b.total)} municípios aderidos, ${fmtPct(b.pct)} de adesão`
        : `${UF_NOME[uf] || uf}: sem dados`;
      html += `<g class="map-tile" data-uf="${uf}" tabindex="0" role="button" aria-label="${ariaLabel}">
        <rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="7" fill="${color}" stroke="#fff" stroke-width="2"></rect>
        ${STATE.mapLabels ? `<text class="map-tile-label" x="${x + cell / 2}" y="${y + cell / 2 + 3.5}">${uf}</text>` : ""}
      </g>`;
    });
    svg.innerHTML = html;

    const tooltip = document.getElementById("mapTooltip");
    svg.querySelectorAll(".map-tile").forEach((g) => {
      const uf = g.getAttribute("data-uf");
      g.addEventListener("mousemove", (e) => {
        const b = agg.byUF[uf];
        tooltip.style.display = "block";
        tooltip.style.left = (e.clientX + 14) + "px";
        tooltip.style.top = (e.clientY + 14) + "px";
        tooltip.innerHTML = b
          ? `<b>${UF_NOME[uf] || uf}</b><br>${fmtInt(b.aderidos)} de ${fmtInt(b.total)} municípios aderidos<br>${fmtPct(b.pct)} de adesão · índice médio ${b.idxMedio.toFixed(1)}`
          : `<b>${UF_NOME[uf] || uf}</b><br>Sem dados`;
      });
      g.addEventListener("mouseleave", () => { tooltip.style.display = "none"; });
      g.addEventListener("focus", () => {
        g.style.outline = "2px solid var(--accent)";
        g.style.outlineOffset = "2px";
      });
      g.addEventListener("blur", () => { g.style.outline = "none"; });
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); g.dispatchEvent(new Event("click")); }
      });
      g.addEventListener("click", () => {
        const b = agg.byUF[uf];
        const panel = document.getElementById(panelId);
        if (!panel) return;
        if (!b) { panel.innerHTML = `<div class="section-sub" style="margin:0;">Sem dados para ${uf}.</div>`; return; }
        panel.innerHTML = `
          <div class="card" style="padding:14px;">
            <div style="font-weight:800;font-size:14px;margin-bottom:8px;">${UF_NOME[uf] || uf} <span class="pill gray" style="margin-left:4px;">${uf}</span></div>
            <div style="display:flex;flex-direction:column;gap:6px;font-size:12.3px;">
              <div>Municípios: <b>${fmtInt(b.total)}</b></div>
              <div>Com adesão: <b style="color:var(--success)">${fmtInt(b.aderidos)}</b> (${fmtPct(b.pct)})</div>
              <div>Sem adesão: <b style="color:var(--danger)">${fmtInt(b.total - b.aderidos)}</b></div>
              <div>Índice médio de maturidade: <b>${b.idxMedio.toFixed(1)} / 5</b></div>
            </div>
          </div>`;
      });
    });
  }

  /* ---------------- Captura de gráfico offscreen (para imagens em relatórios) ----------------
     Usa um canvas temporário com tamanho explícito, fora da árvore de views (que têm
     display:none quando inativas e por isso produziriam imagem em branco/quebrada). */
  function renderChartToImage(config, width, height) {
    if (typeof Chart === "undefined") return "";
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.style.position = "fixed";
    canvas.style.left = "-99999px";
    canvas.style.top = "0";
    document.body.appendChild(canvas);
    let src = "";
    try {
      const offscreenConfig = JSON.parse(JSON.stringify(config, (k, v) => (typeof v === "function" ? undefined : v)));
      offscreenConfig.options = offscreenConfig.options || {};
      offscreenConfig.options.responsive = false;
      offscreenConfig.options.maintainAspectRatio = false;
      offscreenConfig.options.animation = false;
      offscreenConfig.options.devicePixelRatio = 2;
      const chart = new Chart(canvas.getContext("2d"), offscreenConfig);
      src = chart.toBase64Image();
      chart.destroy();
    } catch (e) { src = ""; }
    document.body.removeChild(canvas);
    return src;
  }

  S.renderKPIs = renderKPIs;
  S.renderEvolucaoChart = renderEvolucaoChart;
  S.renderEstadosChart = renderEstadosChart;
  S.renderComponentesChart = renderComponentesChart;
  S.renderDonut = renderDonut;
  S.renderGauge = renderGauge;
  S.renderBrazilMap = renderBrazilMap;
  S.mkChart = mkChart;
  S.ICONS = ICONS;
  S.buildEvolucaoConfig = buildEvolucaoConfig;
  S.buildEstadosConfig = buildEstadosConfig;
  S.renderChartToImage = renderChartToImage;
})();

/* ============================================================================
   PARTE 3 — Alertas, Tabela de Estados, Tabela de Municípios e Modal
   ============================================================================ */
(function () {
  "use strict";
  const S = window.__SNC;
  const { STATE, UF_NOME, COMPONENT_KEYS, COMPONENT_LABELS, classifyMaturity,
    fmtInt, fmtPct, fmtDate, escapeHtml, colorForPct } = S;
  const ICONS = S.ICONS;

  /* ---------------- Alertas automáticos ---------------- */
  function alertCardHtml(opts) {
    const accent = opts.tone === "red" ? "var(--danger)" : "var(--warning)";
    return `
      <div class="card alert-card" style="cursor:pointer;" data-goto="${opts.goto || ""}" data-goto-uf="${opts.gotoUf || ""}">
        <div class="alert-icon ${opts.tone}">${opts.icon}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:13px;">${opts.label}</div>
          <div style="font-size:11.3px;color:var(--muted);margin-top:2px;">${opts.sub}</div>
        </div>
        <div class="alert-count" style="color:${accent};">${opts.value}</div>
      </div>`;
  }

  function renderAlerts(agg) {
    const el = document.getElementById("alertsRow");
    if (!el) return;
    const a = agg.alerts;
    const cards = [];
    cards.push(alertCardHtml({
      tone: "red", icon: ICONS.doc, goto: "componentes",
      label: "Municípios sem Plano de Cultura", sub: "Entre os municípios aderidos ao SNC",
      value: fmtInt(a.semPlano)
    }));
    cards.push(alertCardHtml({
      tone: "red", icon: ICONS.bank, goto: "componentes",
      label: "Municípios sem Conselho de Política Cultural", sub: "Entre os municípios aderidos ao SNC",
      value: fmtInt(a.semConselho)
    }));
    cards.push(alertCardHtml({
      tone: "amber", icon: ICONS.bank, goto: "componentes",
      label: "Municípios sem Fundo de Cultura", sub: "Entre os municípios aderidos ao SNC",
      value: fmtInt(a.semFundo)
    }));
    cards.push(alertCardHtml({
      tone: "red", icon: ICONS.clock, goto: "planos",
      label: "Planos de Cultura vencidos", sub: "Vigência encerrada e ainda não renovada",
      value: fmtInt(a.planosVencidos)
    }));
    cards.push(alertCardHtml({
      tone: "amber", icon: ICONS.clock, goto: "municipios",
      label: "Sem atualização há mais de 2 anos", sub: "Cadastro desatualizado na plataforma SNC",
      value: fmtInt(a.semAtualizacao2anos)
    }));
    if (a.piorEstado) {
      cards.push(alertCardHtml({
        tone: "red", icon: ICONS.flag, gotoUf: a.piorEstado.uf,
        label: "Estado com menor índice de adesão",
        sub: `${UF_NOME[a.piorEstado.uf] || a.piorEstado.uf} · ${fmtInt(a.piorEstado.aderidos)} de ${fmtInt(a.piorEstado.total)} municípios`,
        value: fmtPct(a.piorEstado.pct)
      }));
    }
    el.innerHTML = cards.join("");
    el.querySelectorAll(".alert-card").forEach((card) => {
      card.addEventListener("click", () => {
        const uf = card.getAttribute("data-goto-uf");
        const view = card.getAttribute("data-goto");
        if (uf) window.__SNC.goToUF(uf);
        else if (view) window.__SNC.goTo(view);
      });
    });
  }

  /* ---------------- Tabela por Estado ---------------- */
  function renderEstadosTable(agg) {
    const container = document.getElementById("estadosListContainer");
    if (!container) return;
    if (!STATE.estadosSort) STATE.estadosSort = { key: "aderidos", dir: "desc" };
    const sort = STATE.estadosSort;

    let rows = Object.values(agg.byUF).map((b) => ({
      uf: b.uf, nome: UF_NOME[b.uf] || b.uf, total: b.total, aderidos: b.aderidos, pct: b.pct, idxMedio: b.idxMedio,
      sisPct: b.aderidos ? (b.sis / b.aderidos) * 100 : 0,
      conPct: b.aderidos ? (b.con / b.aderidos) * 100 : 0,
      funPct: b.aderidos ? (b.fun / b.aderidos) * 100 : 0,
      plaPct: b.aderidos ? (b.pla / b.aderidos) * 100 : 0,
      orgPct: b.aderidos ? (b.org / b.aderidos) * 100 : 0
    }));

    const searchTerm = (STATE.estadosSearch || "").toLowerCase();
    if (searchTerm) {
      rows = rows.filter((r) => r.uf.toLowerCase().includes(searchTerm) || r.nome.toLowerCase().includes(searchTerm));
    }

    rows.sort((a, b) => {
      const va = a[sort.key], vb = b[sort.key];
      if (typeof va === "string") return sort.dir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      return sort.dir === "asc" ? va - vb : vb - va;
    });

    const sortKeySel = document.getElementById("estadosSortKey");
    if (sortKeySel && sortKeySel.value !== sort.key) sortKeySel.value = sort.key;
    const sortDirBtn = document.getElementById("estadosSortDir");
    if (sortDirBtn) sortDirBtn.style.transform = sort.dir === "asc" ? "scaleY(-1)" : "none";

    const compFields = [
      { key: "sisPct", label: "Sistema" }, { key: "conPct", label: "Conselho" },
      { key: "funPct", label: "Fundo" }, { key: "plaPct", label: "Plano" }, { key: "orgPct", label: "Órgão Gestor" }
    ];

    if (!rows.length) {
      container.innerHTML = `<div class="section-sub" style="text-align:center;padding:24px;margin:0;">Nenhum estado encontrado.</div>`;
      return;
    }

    container.innerHTML = rows.map((r) => `
      <div class="estado-card" data-uf="${r.uf}">
        <div class="estado-card-header">
          <div class="estado-card-title">
            <span class="pill gray">${r.uf}</span>
            <b>${escapeHtml(r.nome)}</b>
          </div>
          <button class="btn-icon-sm estado-checklist-btn" data-uf="${r.uf}" title="Ver checklist de componentes">
            <svg viewBox="0 0 24 24" fill="none" width="16" height="16"><path d="M9 11l3 3L22 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="estado-card-metrics">
          <div class="estado-metric"><span class="estado-metric-label">Municípios</span><span class="estado-metric-value">${fmtInt(r.total)}</span></div>
          <div class="estado-metric"><span class="estado-metric-label">Aderidos</span><span class="estado-metric-value">${fmtInt(r.aderidos)}</span></div>
          <div class="estado-metric"><span class="estado-metric-label">% Adesão</span><span class="estado-metric-value" style="color:${colorForPct(r.pct)};">${fmtPct(r.pct)}</span></div>
          <div class="estado-metric"><span class="estado-metric-label">Índice médio</span><span class="estado-metric-value">${r.idxMedio.toFixed(1)} / 5</span></div>
        </div>
        <div class="estado-card-components">
          ${compFields.map((c) => `<span class="comp-pill">${c.label} <b>${fmtPct(r[c.key], 0)}</b></span>`).join("")}
        </div>
      </div>`).join("");

    container.querySelectorAll(".estado-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".estado-checklist-btn")) return;
        window.__SNC.goToUF(card.getAttribute("data-uf"));
      });
    });
    container.querySelectorAll(".estado-checklist-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        S.openEstadoModal(btn.getAttribute("data-uf"), STATE.lastAggEstados || STATE.lastAgg);
      });
    });

    S.renderBrazilMap("brazilMapEstados", "mapStatePanelEstados", agg);
  }

  /* ---------------- Detalhe do estado: componentes em formato checklist ---------------- */
  function openEstadoModal(uf, agg) {
    const backdrop = document.getElementById("modalBackdrop");
    const content = document.getElementById("modalContent");
    if (!backdrop || !content) return;
    const b = agg.byUF[uf];
    if (!b) return;
    const compRows = [
      { label: "Sistema Municipal de Cultura", n: b.sis, pct: b.aderidos ? (b.sis / b.aderidos) * 100 : 0 },
      { label: "Conselho de Política Cultural", n: b.con, pct: b.aderidos ? (b.con / b.aderidos) * 100 : 0 },
      { label: "Fundo de Cultura", n: b.fun, pct: b.aderidos ? (b.fun / b.aderidos) * 100 : 0 },
      { label: "Plano de Cultura", n: b.pla, pct: b.aderidos ? (b.pla / b.aderidos) * 100 : 0 },
      { label: "Órgão Gestor de Cultura", n: b.org, pct: b.aderidos ? (b.org / b.aderidos) * 100 : 0 }
    ];
    const checklistHtml = compRows.map((c) => {
      const ok = c.pct >= 50;
      return `
        <div class="detail-item" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <svg viewBox="0 0 24 24" fill="none" width="17" height="17" style="color:${ok ? "var(--success)" : "var(--danger)"};flex-shrink:0;">${ok
              ? '<path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
              : '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'}</svg>
            <span style="font-weight:600;">${c.label}</span>
          </div>
          <div style="text-align:right;color:var(--muted);font-size:12.3px;">${fmtInt(c.n)} de ${fmtInt(b.aderidos)} (${fmtPct(c.pct)})</div>
        </div>`;
    }).join("");
    content.innerHTML = `
      <div class="modal-header">
        <div>
          <h2>${UF_NOME[uf] || uf} <span class="pill gray" style="margin-left:6px;">${uf}</span></h2>
          <span>Checklist de componentes do SNC — % de municípios aderidos com cada componente concluído</span>
        </div>
        <button class="modal-close" id="modalCloseBtn"><svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
      </div>
      <div class="detail-grid">
        <div class="detail-item"><label>Total de municípios</label><div>${fmtInt(b.total)}</div></div>
        <div class="detail-item"><label>Municípios aderidos</label><div>${fmtInt(b.aderidos)} (${fmtPct(b.pct)})</div></div>
        <div class="detail-item"><label>Índice médio de maturidade</label><div>${b.idxMedio.toFixed(1)} / 5</div></div>
      </div>
      <div class="detail-item" style="margin-top:6px;">
        <label style="margin-bottom:10px;display:block;">Checklist de componentes</label>
        <div style="display:flex;flex-direction:column;gap:10px;">${checklistHtml}</div>
      </div>
      <div style="margin-top:16px;text-align:right;">
        <button class="btn btn-secondary" id="estadoModalVerMunicipios">Ver municípios deste estado</button>
      </div>`;
    backdrop.classList.add("open");
    document.getElementById("modalCloseBtn").addEventListener("click", S.closeModal);
    const btnVer = document.getElementById("estadoModalVerMunicipios");
    if (btnVer) btnVer.addEventListener("click", () => { S.closeModal(); window.__SNC.goToUF(uf); });
  }

  S.renderAlerts = renderAlerts;
  S.renderEstadosTable = renderEstadosTable;
  S.openEstadoModal = openEstadoModal;
})();

/* ============================================================================
   PARTE 4 — Tabela de Municípios, Paginação e Modal de Detalhe
   ============================================================================ */
(function () {
  "use strict";
  const S = window.__SNC;
  const { STATE, UF_NOME, COMPONENT_KEYS, COMPONENT_LABELS, classifyMaturity,
    fmtInt, fmtPct, fmtDate, escapeHtml } = S;

  const MUNICIPIOS_COLUMNS = [
    { key: "uf", label: "UF" },
    { key: "m", label: "Município" },
    { key: "sit", label: "Situação" },
    { key: "__comp", label: "Componentes", sortable: false, headerTitle: "Sistema · Conselho · Fundo · Plano · Órgão Gestor (passe o mouse sobre cada bolinha)" },
    { key: "idx", label: "Índice" },
    { key: "upd", label: "Atualizado em" }
  ];

  function renderPaginationMunicipios(filteredCount) {
    const el = document.getElementById("paginationMunicipios");
    if (!el) return;
    const t = STATE.table;
    const totalPages = Math.max(1, Math.ceil(filteredCount / t.pageSize));
    if (t.page > totalPages) t.page = totalPages;
    const startItem = filteredCount === 0 ? 0 : (t.page - 1) * t.pageSize + 1;
    const endItem = Math.min(filteredCount, t.page * t.pageSize);
    el.innerHTML = `
      <div>Mostrando ${fmtInt(startItem)}–${fmtInt(endItem)} de ${fmtInt(filteredCount)} municípios</div>
      <div class="pagination-controls">
        <button class="page-btn" id="pagPrev" ${t.page <= 1 ? "disabled" : ""}>‹ Anterior</button>
        <span style="padding:0 6px;">Página ${t.page} de ${totalPages}</span>
        <button class="page-btn" id="pagNext" ${t.page >= totalPages ? "disabled" : ""}>Próxima ›</button>
      </div>`;
    const prev = document.getElementById("pagPrev");
    const next = document.getElementById("pagNext");
    if (prev) prev.addEventListener("click", () => {
      if (STATE.table.page > 1) {
        STATE.table.page--;
        renderMunicipiosTable();
        const tableEl = document.getElementById("tableMunicipios");
        if (tableEl) tableEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    if (next) next.addEventListener("click", () => {
      STATE.table.page++;
      renderMunicipiosTable();
      const tableEl = document.getElementById("tableMunicipios");
      if (tableEl) tableEl.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function renderMunicipiosTable() {
    const table = document.getElementById("tableMunicipios");
    if (!table) return;
    let rows = STATE.lastFiltered || [];
    if (STATE.table.search) {
      const s = STATE.table.search.toLowerCase();
      rows = rows.filter((r) => r.m.toLowerCase().includes(s) || r.uf.toLowerCase().includes(s));
    }
    const t = STATE.table;
    rows = rows.slice().sort((a, b) => {
      let va = a[t.sortKey], vb = b[t.sortKey];
      if (va === null || va === undefined) va = typeof vb === "number" ? -1 : "";
      if (vb === null || vb === undefined) vb = typeof va === "number" ? -1 : "";
      if (typeof va === "string") return t.sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      return t.sortDir === "asc" ? va - vb : vb - va;
    });

    const totalFiltered = rows.length;
    const start = (t.page - 1) * t.pageSize;
    const pageRows = rows.slice(start, start + t.pageSize);

    const thead = table.querySelector("thead");
    thead.innerHTML = `<tr>${MUNICIPIOS_COLUMNS.map((c) => {
      if (c.sortable === false) return `<th${c.headerTitle ? ` title="${c.headerTitle}" style="cursor:help;text-decoration:underline dotted;text-underline-offset:3px;"` : ""}>${c.label}</th>`;
      const active = t.sortKey === c.key;
      return `<th class="${active ? "sorted" : ""}" data-key="${c.key}" style="cursor:pointer;">${c.label}<span class="sort-arrow">${active ? (t.sortDir === "asc" ? "▲" : "▼") : "↕"}</span></th>`;
    }).join("")}</tr>`;
    thead.querySelectorAll("th[data-key]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.getAttribute("data-key");
        if (t.sortKey === key) t.sortDir = t.sortDir === "asc" ? "desc" : "asc";
        else { t.sortKey = key; t.sortDir = key === "m" ? "asc" : "desc"; }
        renderMunicipiosTable();
      });
    });

    const tbody = table.querySelector("tbody");
    if (!pageRows.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px;white-space:normal;">Nenhum município encontrado para os filtros atuais.</td></tr>`;
    } else {
      tbody.innerHTML = pageRows.map((r, i) => `
        <tr data-row-idx="${i}" style="cursor:pointer;">
          <td><b>${r.uf}</b></td>
          <td>${escapeHtml(r.m)}</td>
          <td><span class="pill ${r.ad ? (r.sit === "Publicado no DOU" ? "green" : "amber") : "red"}"><span class="pill-dot" style="background:currentColor"></span>${escapeHtml(r.sit)}</span></td>
          <td><div class="idx-dot-row">${COMPONENT_KEYS.map((k) => `<span class="idx-dot ${r[k] ? "on" : ""}" title="${COMPONENT_LABELS[k]}: ${r[k] ? "concluído" : "pendente"}"></span>`).join("")}</div></td>
          <td>${r.idx} / 5</td>
          <td>${fmtDate(r.upd)}</td>
        </tr>`).join("");
      tbody.querySelectorAll("tr[data-row-idx]").forEach((tr) => {
        tr.addEventListener("click", () => {
          const idx = parseInt(tr.getAttribute("data-row-idx"), 10);
          openMunicipioModal(pageRows[idx]);
        });
      });
    }

    renderPaginationMunicipios(totalFiltered);
  }

  /* ---------------- Modal de detalhe do município ---------------- */
  function openMunicipioModal(r) {
    const backdrop = document.getElementById("modalBackdrop");
    const content = document.getElementById("modalContent");
    if (!backdrop || !content || !r) return;
    const compItems = COMPONENT_KEYS.map((k) => `
      <div class="detail-item">
        <label>${COMPONENT_LABELS[k]}</label>
        <div style="display:flex;align-items:center;gap:6px;color:${r[k] ? "var(--success)" : "var(--danger)"};font-weight:600;">
          <svg viewBox="0 0 24 24" fill="none" width="16" height="16">${r[k]
            ? '<path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
            : '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'}</svg>
          ${r[k] ? "Concluído" : "Pendente"}
        </div>
      </div>`).join("");
    content.innerHTML = `
      <div class="modal-header">
        <div>
          <h2>${escapeHtml(r.m)} <span class="pill gray" style="margin-left:6px;">${r.uf}</span></h2>
          <span>${UF_NOME[r.uf] || r.uf} · ${r.reg || "—"}${r.ibge ? " · IBGE " + r.ibge : ""}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          <button class="btn-icon-sm" id="modalPrintBtn" title="Imprimir" aria-label="Imprimir ficha do município">
            <svg viewBox="0 0 24 24" fill="none" width="16" height="16"><path d="M6 9V3h12v6M6 18H4a1 1 0 01-1-1v-6a1 1 0 011-1h16a1 1 0 011 1v6a1 1 0 01-1 1h-2" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M6 14h12v7H6v-7z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
          </button>
          <button class="btn-icon-sm" id="modalPdfBtn" title="Exportar PDF" aria-label="Exportar PDF da ficha do município">
            <svg viewBox="0 0 24 24" fill="none" width="16" height="16"><path d="M7 3h7l5 5v13H7V3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 13h4M10 16h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </button>
          <button class="modal-close" id="modalCloseBtn"><svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail-item"><label>Situação da adesão</label><div>${escapeHtml(r.sit)}${r.ad ? "" : " (sem adesão ao SNC)"}</div></div>
        <div class="detail-item"><label>Data de adesão</label><div>${fmtDate(r.dtAd)}</div></div>
        <div class="detail-item"><label>Índice de maturidade</label><div>${r.idx} / 5 — ${classifyMaturity(r.idx).label}</div></div>
        <div class="detail-item"><label>Última atualização</label><div>${fmtDate(r.upd)}</div></div>
        <div class="detail-item" style="grid-column:1/-1;"><label style="margin-bottom:8px;display:block;">Checklist de componentes do SNC</label>
          ${r.ad && r.idx === 0 && r.sit === "Publicado no DOU" ? `
          <div style="background:var(--warning-light);border:1px solid var(--warning);border-radius:10px;padding:10px 14px;margin-bottom:10px;font-size:12px;color:var(--text);display:flex;gap:8px;align-items:flex-start;">
            <svg viewBox="0 0 24 24" fill="none" width="16" height="16" style="flex-shrink:0;margin-top:1px;color:var(--warning);"><path d="M12 9v4M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10.3 3.86L1.82 18a1.8 1.8 0 001.54 2.7h17.28A1.8 1.8 0 0022.18 18L13.7 3.86a1.8 1.8 0 00-3.4 0z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
            <span><b>Inconsistência detectada:</b> este município consta como "Publicado no DOU" na plataforma SNC, mas nenhum componente aparece como concluído. Isso pode indicar atraso na atualização dos dados. Verifique diretamente na plataforma SNC.</span>
          </div>` : ""}
          <div class="detail-grid" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr));padding:0;">${compItems}</div>
        </div>
        <div class="detail-item"><label>Plano de Trabalho</label><div>${escapeHtml(r.pt || "Não informado")}</div></div>
        <div class="detail-item"><label>ACF incluído</label><div>${r.acf ? "Sim" : "Não informado"}</div></div>
        <div class="detail-item"><label>Vigência do Plano de Cultura</label><div>${r.vig || "—"}${r.venc ? " (vencido)" : ""}</div></div>
        <div class="detail-item"><label>Plano monitorado</label><div>${r.mon ? "Sim" : "Não"}</div></div>
        <div class="detail-item"><label>Prefeito(a)</label><div>${escapeHtml(r.pref || "Não informado")}</div></div>
        <div class="detail-item"><label>Cadastrador</label><div>${escapeHtml(r.cad || "Não informado")}</div></div>
        <div class="detail-item"><label>Gestor de Cultura</label><div>${escapeHtml(r.gestor || "Não informado")}</div></div>
        <div class="detail-item"><label>População (2022)</label><div>${r.pop ? fmtInt(r.pop) : "—"}</div></div>
      </div>`;
    backdrop.classList.add("open");
    document.getElementById("modalCloseBtn").addEventListener("click", closeModal);
    document.getElementById("modalPrintBtn").addEventListener("click", printMunicipioModal);
    document.getElementById("modalPdfBtn").addEventListener("click", () => exportMunicipioModalPdf(r));
  }
  function closeModal() {
    const backdrop = document.getElementById("modalBackdrop");
    if (backdrop) backdrop.classList.remove("open");
  }

  /* ---------------- Imprimir o modal de município ---------------- */
  function printMunicipioModal() {
    document.body.classList.add("printing-modal");
    const cleanup = () => document.body.classList.remove("printing-modal");
    window.addEventListener("afterprint", cleanup, { once: true });
    window.print();
    // Garantia extra caso o navegador não dispare "afterprint" (alguns mobile browsers).
    setTimeout(cleanup, 2000);
  }

  /* ---------------- Exportar o modal de município em PDF (independente dos relatórios) ---------------- */
  function exportMunicipioModalPdf(r) {
    if (typeof html2pdf === "undefined") {
      S.showToast("Biblioteca de exportação PDF não carregou — recarregue a página.", true);
      return;
    }
    const hoje = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
    const compRows = COMPONENT_KEYS.map((k) => `
      <tr>
        <td>${COMPONENT_LABELS[k]}</td>
        <td>${r[k] ? '<span style="color:var(--success);font-weight:700;">✓ Concluído</span>' : '<span style="color:var(--danger);font-weight:700;">✗ Pendente</span>'}</td>
      </tr>`).join("");
    const html = `
      <div class="report-page">
        <div class="report-header">
          <div>
            <div class="rh-title">${escapeHtml(r.m)} — ${r.uf}</div>
            <div class="rh-sub">Gerado em ${hoje} · ${UF_NOME[r.uf] || r.uf} · ${r.reg || "—"}${r.ibge ? " · IBGE " + r.ibge : ""}</div>
          </div>
          <div style="text-align:right;font-size:11px;color:var(--muted);">Lei nº 14.835/2024<br>Sistema Nacional de Cultura</div>
        </div>
        <div class="report-section">
          <h3>Situação da Adesão</h3>
          <table class="report-table">
            <tbody>
              <tr><td>Situação</td><td>${escapeHtml(r.sit)}${r.ad ? "" : " (sem adesão ao SNC)"}</td></tr>
              <tr><td>Data de adesão</td><td>${fmtDate(r.dtAd)}</td></tr>
              <tr><td>Índice de maturidade</td><td>${r.idx} / 5 — ${classifyMaturity(r.idx).label}</td></tr>
              <tr><td>Última atualização</td><td>${fmtDate(r.upd)}</td></tr>
            </tbody>
          </table>
        </div>
        <div class="report-section">
          <h3>Checklist de Componentes do SNC</h3>
          <table class="report-table">
            <thead><tr><th>Componente</th><th>Situação</th></tr></thead>
            <tbody>${compRows}</tbody>
          </table>
        </div>
        <div class="report-section">
          <h3>Plano de Cultura e Contatos</h3>
          <table class="report-table">
            <tbody>
              <tr><td>Vigência do Plano de Cultura</td><td>${r.vig || "—"}${r.venc ? " (vencido)" : ""}</td></tr>
              <tr><td>Plano monitorado</td><td>${r.mon ? "Sim" : "Não"}</td></tr>
              <tr><td>Prefeito(a)</td><td>${escapeHtml(r.pref || "Não informado")}</td></tr>
              <tr><td>Cadastrador</td><td>${escapeHtml(r.cad || "Não informado")}</td></tr>
              <tr><td>Gestor de Cultura</td><td>${escapeHtml(r.gestor || "Não informado")}</td></tr>
              <tr><td>População (2022)</td><td>${r.pop ? fmtInt(r.pop) : "—"}</td></tr>
            </tbody>
          </table>
        </div>
        <div style="margin-top:24px;padding-top:14px;border-top:1px solid var(--border);font-size:10.5px;color:var(--muted);text-align:center;">Iniciativa coordenada pelo SNC · Emitido pelo Chefe de Divisão Fagner Silva Ribeiro · Divisão SNC · Ministério da Cultura</div>
      </div>`;

    let container = document.getElementById("modalReportContainer");
    if (!container) {
      container = document.createElement("div");
      container.id = "modalReportContainer";
      container.style.cssText = "position:fixed;left:-99999px;top:0;width:900px;";
      document.body.appendChild(container);
    }
    container.innerHTML = html;
    container.style.display = "block";

    const contentEl = document.getElementById("content");
    if (contentEl) contentEl.scrollTop = 0;
    window.scrollTo(0, 0);

    const slug = r.m.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-");
    const opt = {
      margin: [10, 10, 10, 10],
      filename: `municipio-${slug}-${r.uf.toLowerCase()}.pdf`,
      image: { type: "jpeg", quality: 0.97 },
      html2canvas: { scale: 2, useCORS: true, scrollX: 0, scrollY: 0 },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["css", "legacy"] }
    };
    setTimeout(() => {
      html2pdf().set(opt).from(container.querySelector(".report-page")).save().then(() => {
        container.style.display = "none";
        container.innerHTML = "";
      });
    }, 60);
  }

  S.renderMunicipiosTable = renderMunicipiosTable;
  S.openMunicipioModal = openMunicipioModal;
  S.closeModal = closeModal;
})();

/* ============================================================================
   PARTE 5 — Views especializadas: Brasil, Adesões, Componentes, Planos
   ============================================================================ */
(function () {
  "use strict";
  const S = window.__SNC;
  const { STATE, UF_NOME, COMPONENT_KEYS, COMPONENT_LABELS, COMPONENT_COLORS,
    fmtInt, fmtPct, fmtDate, escapeHtml } = S;
  const ICONS = S.ICONS;

  /* ---------------- Adesões ---------------- */
  function renderAdesoesView(agg) {
    const ultimoAno = agg.evolucao.length ? agg.evolucao[agg.evolucao.length - 1] : null;
    const aguardando = agg.situacaoCount["Aguardando publicação no DOU"] || 0;
    const el = document.getElementById("adesoesKpiRow");
    if (el) {
      el.innerHTML = [
        `
        <div class="card kpi-card">
          <div class="kpi-top"><div class="kpi-label">Municípios com Adesão</div><div class="kpi-icon green">${ICONS.check}</div></div>
          <div class="kpi-value">${fmtInt(agg.aderidosCount)}</div>
          <div class="kpi-delta up">${fmtPct(agg.pctAderidos)} do total nacional</div>
        </div>`,
        `
        <div class="card kpi-card">
          <div class="kpi-top"><div class="kpi-label">Novas adesões no último ano</div><div class="kpi-icon blue">${ICONS.flag}</div></div>
          <div class="kpi-value">${ultimoAno ? fmtInt(ultimoAno.novo) : "—"}</div>
          <div class="kpi-delta flat">${ultimoAno ? "Ano de " + ultimoAno.year : "Sem dados de período"}</div>
        </div>`,
        `
        <div class="card kpi-card">
          <div class="kpi-top"><div class="kpi-label">Aguardando publicação no DOU</div><div class="kpi-icon amber">${ICONS.clock}</div></div>
          <div class="kpi-value">${fmtInt(aguardando)}</div>
          <div class="kpi-delta flat">Adesões em processamento</div>
        </div>`,
        `
        <div class="card kpi-card">
          <div class="kpi-top"><div class="kpi-label">Índice médio de maturidade</div><div class="kpi-icon amber">${ICONS.gauge}</div></div>
          <div class="kpi-value">${agg.mediaMaturidadeAderidos.toFixed(1)} / 5</div>
          <div class="kpi-delta flat">Entre municípios aderidos</div>
        </div>`
      ].join("");
    }
    S.renderEvolucaoChart(agg, "chartEvolucaoAdesoes");

    const table = document.getElementById("tableRecentes");
    if (table) {
      const recentes = agg.aderidosArr.filter((r) => r.upd).slice().sort((a, b) => (b.upd > a.upd ? 1 : -1)).slice(0, 15);
      table.querySelector("thead").innerHTML = `<tr><th>Município</th><th>UF</th><th>Situação</th><th>Índice</th><th>Atualizado em</th></tr>`;
      table.querySelector("tbody").innerHTML = recentes.map((r) => `
        <tr>
          <td>${escapeHtml(r.m)}</td>
          <td><b>${r.uf}</b></td>
          <td><span class="pill ${r.sit === "Publicado no DOU" ? "green" : "amber"}"><span class="pill-dot" style="background:currentColor"></span>${escapeHtml(r.sit)}</span></td>
          <td>${r.idx} / 5</td>
          <td>${fmtDate(r.upd)}</td>
        </tr>`).join("") || `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px;">Sem registros recentes.</td></tr>`;
    }
  }

  /* ---------------- Componentes ---------------- */
  function renderComponentesView(agg) {
    S.renderComponentesChart(agg, "chartComponentesDetalhe");
    S.renderDonut(agg, "chartDonut2", "donutLegend2");

    const el = document.getElementById("componentCards");
    if (el) {
      el.innerHTML = COMPONENT_KEYS.map((k) => {
        const c = agg.componentRates[k];
        const faltam = agg.aderidosCount - c.n;
        return `
          <div class="card">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
              <span style="width:10px;height:10px;border-radius:50%;background:${COMPONENT_COLORS[k]};flex-shrink:0;"></span>
              <div class="card-title" style="font-size:13px;">${COMPONENT_LABELS[k]}</div>
            </div>
            <div class="kpi-value" style="font-size:24px;">${fmtPct(c.pct)}</div>
            <div style="font-size:11.5px;color:var(--muted);margin-top:6px;">${fmtInt(c.n)} concluídos · ${fmtInt(faltam)} pendentes</div>
          </div>`;
      }).join("");
    }
  }

  /* ---------------- Planos de Cultura ---------------- */
  function renderPlanosView(agg) {
    const planoData = agg.componentRates.pla;
    const monitorados = agg.aderidosArr.filter((r) => r.pla === 1 && r.mon === 1).length;
    const naoMonitorados = agg.aderidosArr.filter((r) => r.pla === 1 && r.mon === 0).length;
    const semVigencia = agg.aderidosArr.filter((r) => r.pla === 1 && !r.vig).length;

    const el = document.getElementById("planosKpiRow");
    if (el) {
      el.innerHTML = [
        `<div class="card kpi-card">
          <div class="kpi-top"><div class="kpi-label">Planos de Cultura concluídos</div><div class="kpi-icon green">${ICONS.check}</div></div>
          <div class="kpi-value">${fmtInt(planoData.n)}</div>
          <div class="kpi-delta up">${fmtPct(planoData.pct)} dos municípios aderidos</div>
        </div>`,
        `<div class="card kpi-card">
          <div class="kpi-top"><div class="kpi-label">Planos vencidos</div><div class="kpi-icon red">${ICONS.x}</div></div>
          <div class="kpi-value">${fmtInt(agg.alerts.planosVencidos)}</div>
          <div class="kpi-delta down">Vigência encerrada</div>
        </div>`,
        `<div class="card kpi-card">
          <div class="kpi-top"><div class="kpi-label">Planos monitorados</div><div class="kpi-icon blue">${ICONS.gauge}</div></div>
          <div class="kpi-value">${fmtInt(monitorados)}</div>
          <div class="kpi-delta flat">${fmtInt(naoMonitorados)} não monitorados</div>
        </div>`,
        `<div class="card kpi-card">
          <div class="kpi-top"><div class="kpi-label">Sem ano de vigência informado</div><div class="kpi-icon amber">${ICONS.clock}</div></div>
          <div class="kpi-value">${fmtInt(semVigencia)}</div>
          <div class="kpi-delta flat">Entre planos concluídos</div>
        </div>`
      ].join("");
    }

    S.mkChart("chartPeriodicidade", {
      type: "doughnut",
      data: {
        labels: ["Monitorado", "Não monitorado"],
        datasets: [{ data: [monitorados, naoMonitorados], backgroundColor: ["#16a34a", "#d2d2d7"], borderWidth: 2, borderColor: "#fff" }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "62%",
        plugins: { legend: { position: "bottom", labels: { boxWidth: 9, boxHeight: 9, usePointStyle: true } } }
      }
    });

    const years = Object.keys(agg.vigenciaCount).map((y) => parseInt(y, 10)).filter((y) => !isNaN(y)).sort((a, b) => a - b);
    const recentYears = years.slice(-12);
    S.mkChart("chartVigencia", {
      type: "bar",
      data: {
        labels: recentYears.map(String),
        datasets: [{
          data: recentYears.map((y) => agg.vigenciaCount[y] || 0),
          backgroundColor: recentYears.map((y) => y < new Date().getFullYear() ? "#dc2626" : "#2f6feb"),
          borderRadius: 6, maxBarThickness: 28
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, grid: { color: "#eef2f7" } }, x: { grid: { display: false } } }
      }
    });
  }

  /* ---------------- Fundo de Cultura ---------------- */
  const STATUS_ORDEM = ["Concluída", "Avaliando anexo", "Em preenchimento", "Arquivo incorreto", "Arquivo incompleto", "Arquivo danificado", "Não informado(a)"];
  const STATUS_CORES = { "Concluída": "#16a34a", "Avaliando anexo": "#2f6feb", "Em preenchimento": "#f2994a", "Arquivo incorreto": "#dc2626", "Arquivo incompleto": "#dc2626", "Arquivo danificado": "#dc2626", "Não informado(a)": "#d2d2d7" };

  function statusDistribution(aderidosArr, key) {
    const count = {};
    aderidosArr.forEach((r) => {
      const v = r[key] || "Não informado(a)";
      count[v] = (count[v] || 0) + 1;
    });
    const labels = STATUS_ORDEM.filter((s) => count[s]);
    return { labels, values: labels.map((s) => count[s]), colors: labels.map((s) => STATUS_CORES[s] || "#94a3b8") };
  }

  function renderFundoView(agg) {
    const fundoData = agg.componentRates.fun;
    const aderidos = agg.aderidosArr;
    const avaliandoAnexo = aderidos.filter((r) => r.funSt === "Avaliando anexo").length;
    const comProblema = aderidos.filter((r) => ["Arquivo incorreto", "Arquivo incompleto", "Arquivo danificado"].includes(r.funSt)).length;

    const el = document.getElementById("fundoKpiRow");
    if (el) {
      el.innerHTML = [
        `<div class="card kpi-card">
          <div class="kpi-top"><div class="kpi-label">Fundos de Cultura concluídos</div><div class="kpi-icon green">${ICONS.check}</div></div>
          <div class="kpi-value">${fmtInt(fundoData.n)}</div>
          <div class="kpi-delta up">${fmtPct(fundoData.pct)} dos municípios aderidos</div>
        </div>`,
        `<div class="card kpi-card">
          <div class="kpi-top"><div class="kpi-label">Fundos pendentes</div><div class="kpi-icon red">${ICONS.x}</div></div>
          <div class="kpi-value">${fmtInt(agg.alerts.semFundo)}</div>
          <div class="kpi-delta down">Sem lei concluída</div>
        </div>`,
        `<div class="card kpi-card">
          <div class="kpi-top"><div class="kpi-label">Avaliando anexo</div><div class="kpi-icon amber">${ICONS.clock}</div></div>
          <div class="kpi-value">${fmtInt(avaliandoAnexo)}</div>
          <div class="kpi-delta flat">Em análise pela equipe SNC</div>
        </div>`,
        `<div class="card kpi-card">
          <div class="kpi-top"><div class="kpi-label">Arquivo com problema</div><div class="kpi-icon red">${ICONS.x}</div></div>
          <div class="kpi-value">${fmtInt(comProblema)}</div>
          <div class="kpi-delta down">Incorreto, incompleto ou danificado</div>
        </div>`
      ].join("");
    }

    const dist = statusDistribution(aderidos, "funSt");
    S.mkChart("chartFundoStatus", {
      type: "doughnut",
      data: { labels: dist.labels, datasets: [{ data: dist.values, backgroundColor: dist.colors, borderWidth: 2, borderColor: "#fff" }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "62%",
        plugins: { legend: { position: "bottom", labels: { boxWidth: 9, boxHeight: 9, usePointStyle: true, font: { size: 10.5 } } } }
      }
    });

    const fundoAnoCount = {};
    aderidos.forEach((r) => { if (r.funData) { const y = r.funData.slice(0, 4); fundoAnoCount[y] = (fundoAnoCount[y] || 0) + 1; } });
    const fundoAnos = Object.keys(fundoAnoCount).sort().slice(-12);
    S.mkChart("chartFundoAno", {
      type: "bar",
      data: { labels: fundoAnos, datasets: [{ data: fundoAnos.map((y) => fundoAnoCount[y]), backgroundColor: "#2f6feb", borderRadius: 6, maxBarThickness: 28 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, grid: { color: "#eef2f7" } }, x: { grid: { display: false } } }
      }
    });
  }

  /* ---------------- Conselho ---------------- */
  function renderConselhoView(agg) {
    const conData = agg.componentRates.con;
    const aderidos = agg.aderidosArr;
    const concluidos = aderidos.filter((r) => r.con === 1);
    const paritarios = concluidos.filter((r) => r.conParit === true).length;
    const exclusivos = concluidos.filter((r) => r.conExcl === true).length;

    const el = document.getElementById("conselhoKpiRow");
    if (el) {
      el.innerHTML = [
        `<div class="card kpi-card">
          <div class="kpi-top"><div class="kpi-label">Conselhos concluídos</div><div class="kpi-icon green">${ICONS.check}</div></div>
          <div class="kpi-value">${fmtInt(conData.n)}</div>
          <div class="kpi-delta up">${fmtPct(conData.pct)} dos municípios aderidos</div>
        </div>`,
        `<div class="card kpi-card">
          <div class="kpi-top"><div class="kpi-label">Conselhos pendentes</div><div class="kpi-icon red">${ICONS.x}</div></div>
          <div class="kpi-value">${fmtInt(agg.alerts.semConselho)}</div>
          <div class="kpi-delta down">Sem lei concluída</div>
        </div>`,
        `<div class="card kpi-card">
          <div class="kpi-top"><div class="kpi-label">Paritários</div><div class="kpi-icon blue">${ICONS.gauge}</div></div>
          <div class="kpi-value">${fmtInt(paritarios)}</div>
          <div class="kpi-delta flat">Entre os concluídos</div>
        </div>`,
        `<div class="card kpi-card">
          <div class="kpi-top"><div class="kpi-label">Exclusivos de cultura</div><div class="kpi-icon blue">${ICONS.gauge}</div></div>
          <div class="kpi-value">${fmtInt(exclusivos)}</div>
          <div class="kpi-delta flat">Entre os concluídos</div>
        </div>`
      ].join("");
    }

    const dist = statusDistribution(aderidos, "conSt");
    S.mkChart("chartConselhoStatus", {
      type: "doughnut",
      data: { labels: dist.labels, datasets: [{ data: dist.values, backgroundColor: dist.colors, borderWidth: 2, borderColor: "#fff" }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "62%",
        plugins: { legend: { position: "bottom", labels: { boxWidth: 9, boxHeight: 9, usePointStyle: true, font: { size: 10.5 } } } }
      }
    });

    const naoParitarios = concluidos.length - paritarios;
    const naoExclusivos = concluidos.length - exclusivos;
    S.mkChart("chartConselhoNatureza", {
      type: "bar",
      data: {
        labels: ["Paritário", "Não paritário", "Exclusivo de cultura", "Compartilhado"],
        datasets: [{
          data: [paritarios, naoParitarios, exclusivos, naoExclusivos],
          backgroundColor: ["#2f6feb", "#d2d2d7", "#16a34a", "#d2d2d7"],
          borderRadius: 6, maxBarThickness: 36
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, grid: { color: "#eef2f7" } }, x: { grid: { display: false } } }
      }
    });
  }

  S.renderAdesoesView = renderAdesoesView;
  S.renderComponentesView = renderComponentesView;
  S.renderPlanosView = renderPlanosView;
  S.renderFundoView = renderFundoView;
  S.renderConselhoView = renderConselhoView;
})();

/* ============================================================================
   PARTE 6 — Relatório Executivo e Exportações (PDF / Excel)
   ============================================================================ */
(function () {
  "use strict";
  const S = window.__SNC;
  const { STATE, UF_NOME, COMPONENT_KEYS, COMPONENT_LABELS,
    fmtInt, fmtPct, fmtDate, escapeHtml } = S;

  function chartImg(configBuilder, agg, alt) {
    try {
      const config = configBuilder(agg);
      const src = S.renderChartToImage(config, 1000, 420);
      if (!src || src === "data:,") return "";
      return `<img src="${src}" alt="${alt}" style="width:100%;max-width:520px;display:block;margin:0 auto;">`;
    } catch (e) { return ""; }
  }

  function renderReport(agg) {
    const el = document.getElementById("reportContainer");
    if (!el || !agg) return;
    STATE.reportOrientation = "portrait";
    STATE.reportFilename = `relatorio-executivo-snc-${new Date().toISOString().slice(0,10)}.pdf`;

    const hoje = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
    const ufLabel = STATE.filters.uf ? `Filtro aplicado: ${UF_NOME[STATE.filters.uf] || STATE.filters.uf}` : "Abrangência: nacional";

    const rankingTop = Object.values(agg.byUF).filter((b) => b.total >= 1).sort((a, b) => b.pct - a.pct).slice(0, 10);
    const rankingBottom = Object.values(agg.byUF).filter((b) => b.total >= 3).sort((a, b) => a.pct - b.pct).slice(0, 5);
    const destaque = agg.aderidosArr.slice().sort((a, b) => b.idx - a.idx || a.m.localeCompare(b.m)).slice(0, 8);

    el.innerHTML = `
      <div class="report-page">
        <div class="report-header">
          <div>
            <div class="rh-title">Relatório Executivo — Sistema Nacional de Cultura</div>
            <div class="rh-sub">Gerado em ${hoje} · ${ufLabel}</div>
          </div>
          <div style="text-align:right;font-size:11px;color:var(--muted);">
            Iniciativa coordenada pelo SNC<br>Criado pelo Chefe de Divisão Fagner Silva Ribeiro
          </div>
        </div>

        <div class="report-section">
          <h3>Resumo Nacional</h3>
          <table class="report-table">
            <thead><tr><th>Indicador</th><th>Valor</th></tr></thead>
            <tbody>
              <tr><td>Total de municípios</td><td>${fmtInt(agg.total)}</td></tr>
              <tr><td>Municípios com adesão</td><td>${fmtInt(agg.aderidosCount)} (${fmtPct(agg.pctAderidos)})</td></tr>
              <tr><td>Municípios sem adesão</td><td>${fmtInt(agg.naoAderidos)} (${fmtPct(100 - agg.pctAderidos)})</td></tr>
              <tr><td>Índice Nacional de Implementação</td><td>${fmtPct(agg.indiceNacional)}</td></tr>
              <tr><td>Índice médio de maturidade (aderidos)</td><td>${agg.mediaMaturidadeAderidos.toFixed(1)} / 5</td></tr>
            </tbody>
          </table>
        </div>

        <div class="report-section">
          <h3>Evolução das Adesões</h3>
          ${chartImg(S.buildEvolucaoConfig, agg, "Evolução das adesões")}
        </div>

        <div class="report-section">
          <h3>Ranking dos Estados (Top 10 por % de adesão)</h3>
          <table class="report-table">
            <thead><tr><th>UF</th><th>Estado</th><th>Aderidos</th><th>Total</th><th>% Adesão</th><th>Índice médio</th></tr></thead>
            <tbody>
              ${rankingTop.map((b) => `<tr><td><b>${b.uf}</b></td><td>${UF_NOME[b.uf] || b.uf}</td><td>${fmtInt(b.aderidos)}</td><td>${fmtInt(b.total)}</td><td>${fmtPct(b.pct)}</td><td>${b.idxMedio.toFixed(1)} / 5</td></tr>`).join("")}
            </tbody>
          </table>
        </div>

        <div class="report-section">
          <h3>Municípios em Destaque</h3>
          <table class="report-table">
            <thead><tr><th>Município</th><th>UF</th><th>Índice</th><th>Situação</th></tr></thead>
            <tbody>
              ${destaque.map((r) => `<tr><td>${escapeHtml(r.m)}</td><td><b>${r.uf}</b></td><td>${r.idx} / 5</td><td>${escapeHtml(r.sit)}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>

        <div class="report-section">
          <h3>Estados com Menor Índice de Adesão</h3>
          <table class="report-table">
            <thead><tr><th>UF</th><th>Estado</th><th>Aderidos</th><th>Total</th><th>% Adesão</th></tr></thead>
            <tbody>
              ${rankingBottom.map((b) => `<tr><td><b>${b.uf}</b></td><td>${UF_NOME[b.uf] || b.uf}</td><td>${fmtInt(b.aderidos)}</td><td>${fmtInt(b.total)}</td><td>${fmtPct(b.pct)}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>

        <div class="report-section">
          <h3>Análise dos Componentes do SNC</h3>
          <table class="report-table">
            <thead><tr><th>Componente</th><th>Concluídos</th><th>% sobre aderidos</th></tr></thead>
            <tbody>
              ${COMPONENT_KEYS.map((k) => `<tr><td>${COMPONENT_LABELS[k]}</td><td>${fmtInt(agg.componentRates[k].n)}</td><td>${fmtPct(agg.componentRates[k].pct)}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>

        <div class="report-section">
          <h3>Alertas de Gestão</h3>
          <table class="report-table">
            <thead><tr><th>Indicador</th><th>Quantidade</th></tr></thead>
            <tbody>
              <tr><td>Municípios sem Plano de Cultura</td><td>${fmtInt(agg.alerts.semPlano)}</td></tr>
              <tr><td>Municípios sem Conselho de Política Cultural</td><td>${fmtInt(agg.alerts.semConselho)}</td></tr>
              <tr><td>Municípios sem Fundo de Cultura</td><td>${fmtInt(agg.alerts.semFundo)}</td></tr>
              <tr><td>Planos de Cultura vencidos</td><td>${fmtInt(agg.alerts.planosVencidos)}</td></tr>
              <tr><td>Sem atualização há mais de 2 anos</td><td>${fmtInt(agg.alerts.semAtualizacao2anos)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>`;
  }

  /* ---------------- Exportação Excel ---------------- */
  function exportExcel() {
    if (typeof XLSX === "undefined") {
      S.showToast("Biblioteca de planilhas não carregou — recarregue a página e tente novamente.", true);
      return;
    }
    const rows = STATE.lastFiltered || STATE.raw;
    const data = rows.map((r) => ({
      "Ente Federado": r.m, "UF": r.uf, "Região": r.reg,
      "Situação": r.sit, "Data Adesão": r.dtAd ? fmtDate(r.dtAd) : "Não possui adesão",
      "Sistema": r.sis ? "Concluída" : "Pendente", "Conselho": r.con ? "Concluída" : "Pendente",
      "Fundo": r.fun ? "Concluída" : "Pendente", "Plano": r.pla ? "Concluída" : "Pendente",
      "Órgão Gestor": r.org ? "Concluída" : "Pendente", "Índice (0-5)": r.idx,
      "Última atualização": r.upd ? fmtDate(r.upd) : "—",
      "Prefeito(a)": r.pref || "Não informado", "Cadastrador": r.cad || "Não informado",
      "Gestor de Cultura": r.gestor || "Não informado", "População (2022)": r.pop || ""
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws["!cols"] = [{ wch: 28 }, { wch: 5 }, { wch: 14 }, { wch: 24 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 11 }, { wch: 16 }, { wch: 26 }, { wch: 26 }, { wch: 26 }, { wch: 14 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Municípios SNC");
    const dataStr = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `snc-municipios-${dataStr}.xlsx`);
  }

  /* ---------------- Exportação PDF ---------------- */
  function exportPdfReport() {
    if (typeof html2pdf === "undefined") {
      S.showToast("Biblioteca de exportação PDF não carregou — recarregue a página e tente novamente.", true);
      return;
    }
    if (!document.getElementById("reportContainer").innerHTML.trim()) {
      STATE.activeReportKind = "executivo";
      renderReport(STATE.lastAgg);
    }
    window.__SNC.goTo("relatorios");
    const target = document.querySelector("#reportContainer .report-page");
    if (!target) return;
    // Reset scroll position before capture: html2canvas can produce duplicated/ghosted
    // content when the scrollable container (#content) isn't at the top, since it
    // miscalculates element offsets relative to the scrolled viewport.
    const contentEl = document.getElementById("content");
    if (contentEl) contentEl.scrollTop = 0;
    window.scrollTo(0, 0);
    const dataStr = new Date().toISOString().slice(0, 10);
    const opt = {
      margin: [10, 10, 10, 10],
      filename: STATE.reportFilename || `relatorio-executivo-snc-${dataStr}.pdf`,
      image: { type: "jpeg", quality: 0.97 },
      html2canvas: { scale: 2, useCORS: true, scrollX: 0, scrollY: 0 },
      jsPDF: { unit: "mm", format: "a4", orientation: STATE.reportOrientation || "portrait" },
      pagebreak: { mode: ["css", "legacy"] }
    };
    setTimeout(() => { html2pdf().set(opt).from(target).save(); }, 60);
  }

  S.renderReport = renderReport;
  S.exportExcel = exportExcel;
  S.exportPdfReport = exportPdfReport;
})();

/* ============================================================================
   PARTE 7 — Navegação, Filtros, Upload, Configurações e Inicialização
   ============================================================================ */
(function () {
  "use strict";
  const S = window.__SNC;
  const { STATE, UF_NOME, fmtInt, fmtPct, fmtDate, debounce, escapeHtml } = S;

  const VIEW_META = {
    dashboard: { title: "Dashboard Executivo", sub: "Monitoramento nacional do Sistema Nacional de Cultura" },
    estados: { title: "Estados", sub: "Painel comparativo por unidade federativa" },
    municipios: { title: "Municípios", sub: "Tabela executiva com busca, ordenação e detalhamento" },
    adesoes: { title: "Adesões", sub: "Evolução histórica e situação das adesões ao SNC" },
    componentes: { title: "Componentes", sub: "Sistema, Conselho, Fundo, Plano e Órgão Gestor" },
    planos: { title: "Planos de Cultura", sub: "Monitoramento e vigência dos planos municipais" },
    fundo: { title: "Fundo de Cultura", sub: "Situação da Lei do Fundo Municipal de Cultura" },
    conselho: { title: "Conselho", sub: "Situação da Lei do Conselho de Política Cultural" },
    relatorios: { title: "Relatórios", sub: "Relatório executivo consolidado, pronto para exportação" },
    exportacoes: { title: "Exportações", sub: "Exportação de dados e atualização da base" },
    config: { title: "Configurações", sub: "Preferências de exibição e fonte de dados" }
  };

  /* ---------------- Navegação ---------------- */
  /* ---------------- Menu lateral: recolher (desktop) / gaveta (mobile) ---------------- */
  function isMobileLayout() {
    return window.innerWidth <= 860;
  }

  function toggleSidebar() {
    if (isMobileLayout()) {
      document.body.classList.toggle("sidebar-mobile-open");
    } else {
      document.body.classList.toggle("sidebar-collapsed");
      try { localStorage.setItem("snc-sidebar-collapsed", document.body.classList.contains("sidebar-collapsed") ? "1" : "0"); } catch (e) { /* sem suporte a localStorage, ignora */ }
    }
  }

  function closeSidebarMobile() {
    document.body.classList.remove("sidebar-mobile-open");
  }

  function initSidebarState() {
    if (!isMobileLayout()) {
      try {
        if (localStorage.getItem("snc-sidebar-collapsed") === "1") document.body.classList.add("sidebar-collapsed");
      } catch (e) { /* sem suporte a localStorage, ignora */ }
    }
    window.addEventListener("resize", debounce(() => {
      if (!isMobileLayout()) document.body.classList.remove("sidebar-mobile-open");
    }, 150));
  }

  function goTo(view) {
    if (!VIEW_META[view]) return;
    STATE.currentView = view;
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.getAttribute("data-view") === view));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
    const meta = VIEW_META[view];
    document.getElementById("topbarTitle").textContent = meta.title;
    document.getElementById("topbarSub").textContent = meta.sub;
    const content = document.getElementById("content");
    if (content) content.scrollTop = 0;
    window.scrollTo(0, 0);

    // A busca por nome de município não se aplica à tela de Estados — esse filtro
    // existe só para localizar municípios individuais nas demais telas.
    const searchControl = document.getElementById("globalMunicipioFilter")
      ? document.getElementById("globalMunicipioFilter").closest(".search-control")
      : null;
    if (searchControl) searchControl.style.display = view === "estados" ? "none" : "";
  }

  function goToUF(uf) {
    STATE.filters.uf = uf;
    const sel = document.getElementById("ufFilter");
    if (sel) sel.value = uf;
    refreshAll();
    goTo("municipios");
  }

  /* ---------------- Toast ---------------- */
  function showToast(msg, isError) {
    const el = document.getElementById("toast");
    if (!el) return;
    const icon = isError
      ? `<svg viewBox="0 0 24 24" fill="none" style="color:var(--danger)"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M9 9l6 6M15 9l-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none"><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/></svg>`;
    el.innerHTML = `${icon}<span>${escapeHtml(msg)}</span>`;
    el.classList.add("show");
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => el.classList.remove("show"), 3400);
  }

  /* ---------------- Refresh central ---------------- */
  function refreshAll(resetPage) {
    const filtered = S.applyFilters(STATE.raw);
    const agg = S.computeAggregates(filtered);
    STATE.lastFiltered = filtered;
    STATE.lastAgg = agg;
    if (resetPage !== false) STATE.table.page = 1;

    // BUG#2 / BUG#19: para o card "Total de Municípios" e o mapa, o universo base
    // deve ignorar o filtro de adesão — só aplica UF, região e período.
    // Assim o total e o percentual do mapa refletem sempre o universo real.
    const filteredBase = STATE.raw.filter((r) => {
      if (STATE.filters.uf && r.uf !== STATE.filters.uf) return false;
      if (STATE.filters.regiao && r.reg !== STATE.filters.regiao) return false;
      if (STATE.filters.periodo && (!r.dtAd || !r.dtAd.startsWith(STATE.filters.periodo))) return false;
      return true;
    });
    const aggBase = S.computeAggregates(filteredBase);
    STATE.lastAggBase = aggBase;

    // KPIs: Total usa aggBase (universo real), aderidos/sem adesão usam agg (filtrado)
    S.renderKPIs(agg, aggBase, "kpiRow");
    S.renderEvolucaoChart(agg, "chartEvolucao");
    S.renderEstadosChart(agg, "chartEstados");
    S.renderComponentesChart(agg, "chartComponentes");
    S.renderDonut(agg, "chartDonut", "donutLegend");
    S.renderGauge(agg);
    // Mapa sempre usa aggBase para que os percentuais sejam sobre o total real
    S.renderBrazilMap("brazilMap", "mapStatePanel", aggBase);
    S.renderAlerts(agg);

    // Estados não usa o filtro de busca por nome de município (esse campo nem aparece
    // nessa tela) — recalcula um agregado próprio considerando UF, região, adesão e período.
    const filteredForEstados = STATE.raw.filter((r) => {
      if (STATE.filters.uf && r.uf !== STATE.filters.uf) return false;
      if (STATE.filters.regiao && r.reg !== STATE.filters.regiao) return false;
      if (STATE.filters.adesao === "com" && !r.ad) return false;
      if (STATE.filters.adesao === "sem" && r.ad) return false;
      if (STATE.filters.periodo && (!r.dtAd || !r.dtAd.startsWith(STATE.filters.periodo))) return false;
      return true;
    });
    STATE.lastAggEstados = S.computeAggregates(filteredForEstados);
    S.renderEstadosTable(STATE.lastAggEstados);

    S.renderMunicipiosTable();
    S.renderAdesoesView(agg);
    S.renderComponentesView(agg);
    S.renderPlanosView(agg);
    S.renderFundoView(agg);
    S.renderConselhoView(agg);

    // Mantém o Relatório Executivo sempre em sincronia com os filtros globais.
    // BUG#11: usa aggBase (ignora filtro de adesão) para o relatório executivo
    // não mostrar dados distorcidos quando "Com adesão" está ativo.
    if (STATE.activeReportKind === "executivo") {
      S.renderReport(aggBase);
    }

    const cfgFonte = document.getElementById("cfgFonte");
    const cfgTotal = document.getElementById("cfgTotal");
    if (cfgFonte) cfgFonte.textContent = STATE.sourceLabel;
    if (cfgTotal) cfgTotal.textContent = fmtInt(STATE.raw.length) + " municípios carregados";

    const lastUpdEl = document.getElementById("lastDataUpdate");
    if (lastUpdEl) {
      const datasUpd = STATE.raw.filter((r) => r.upd).map((r) => r.upd);
      if (datasUpd.length) {
        const maisRecente = datasUpd.reduce((max, d) => (d > max ? d : max));
        lastUpdEl.textContent = `Dados da plataforma até ${fmtDate(maisRecente)}`;
      } else {
        lastUpdEl.textContent = "";
      }
    }
    if (S.updateFilterIndicator) S.updateFilterIndicator();
  }

  /* ---------------- Filtros (topbar) ---------------- */
  function populateFilters() {
    const ufSel = document.getElementById("ufFilter");
    if (ufSel) {
      const ufsPresentes = Array.from(new Set(STATE.raw.map((r) => r.uf))).sort((a, b) => (UF_NOME[a] || a).localeCompare(UF_NOME[b] || b));
      ufSel.innerHTML = `<option value="">Todos os estados</option>` + ufsPresentes.map((uf) => `<option value="${uf}">${UF_NOME[uf] || uf} (${uf})</option>`).join("");
    }
    const periodSel = document.getElementById("periodFilter");
    if (periodSel) {
      const anos = Array.from(new Set(STATE.raw.filter((r) => r.dtAd).map((r) => r.dtAd.slice(0, 4)))).sort().reverse();
      periodSel.innerHTML = `<option value="">Ano de adesão</option>` + anos.map((y) => `<option value="${y}">${y}</option>`).join("");
    }
    const pageSizeSel = document.getElementById("cfgPageSize");
    if (pageSizeSel) pageSizeSel.value = String(STATE.table.pageSize);

    const repEstadoSel = document.getElementById("repEstado");
    if (repEstadoSel) {
      const ufsPresentes = Array.from(new Set(STATE.raw.map((r) => r.uf))).sort((a, b) => (UF_NOME[a] || a).localeCompare(UF_NOME[b] || b));
      const previous = repEstadoSel.value;
      repEstadoSel.innerHTML = `<option value="">Selecione...</option>` + ufsPresentes.map((uf) => `<option value="${uf}">${UF_NOME[uf] || uf} (${uf})</option>`).join("");
      if (ufsPresentes.includes(previous)) repEstadoSel.value = previous;
    }
    populateRepMunicipioSelect(document.getElementById("repEstado") ? document.getElementById("repEstado").value : "");
  }

  /* ---------------- Cascata Estado -> Município (painel de Relatórios) ---------------- */
  function populateRepMunicipioSelect(uf) {
    const sel = document.getElementById("repMunicipio");
    if (!sel) return;
    if (!uf) {
      sel.innerHTML = `<option value="">Selecione o estado primeiro</option>`;
      return;
    }
    const tipoEl = document.getElementById("repTipo");
    const isContatos = tipoEl && tipoEl.value === "contatos";
    const placeholder = isContatos ? "Todos os municípios do estado" : "Selecione...";
    const municipios = STATE.raw.filter((r) => r.uf === uf).slice().sort((a, b) => a.m.localeCompare(b.m));
    sel.innerHTML = `<option value="">${placeholder}</option>` + municipios.map((r) =>
      `<option value="${escapeHtml(r.m)}">${escapeHtml(r.m)}${!r.ad ? " (sem adesão)" : ""}</option>`
    ).join("");
  }

  function updateRepFormVisibility() {
    const tipoSel = document.getElementById("repTipo");
    if (!tipoSel) return;
    const tipo = tipoSel.value;
    const muniWrap = document.getElementById("repMunicipioWrap");
    const filtroWrap = document.getElementById("repFiltroWrap");
    if (muniWrap) muniWrap.style.display = (tipo === "municipio" || tipo === "contatos") ? "" : "none";
    if (filtroWrap) filtroWrap.style.display = tipo === "checklist" ? "" : "none";
    const repEstadoEl = document.getElementById("repEstado");
    if (tipo === "contatos" || tipo === "municipio") populateRepMunicipioSelect(repEstadoEl ? repEstadoEl.value : "");
  }

  /* ---------------- Upload de planilha ---------------- */
  function handleFileUpload(file) {
    if (!file) return;
    if (typeof XLSX === "undefined") {
      showToast("Biblioteca de planilhas não carregou — recarregue a página e tente novamente.", true);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        const firstSheetName = wb.SheetNames.find((n) => /snc/i.test(n)) || wb.SheetNames[0];
        const sheet = wb.Sheets[firstSheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        const normalized = S.normalizeUploadedRows(rows);
        if (!normalized.length) throw new Error("A planilha não contém municípios reconhecíveis.");
        STATE.raw = normalized;
        STATE.sourceLabel = `Planilha carregada: ${file.name} (${normalized.length} municípios)`;
        STATE.filters = { uf: "", regiao: "", adesao: "", periodo: "", search: "" };
        document.getElementById("globalMunicipioFilter").value = "";
        const regiaoSelReset = document.getElementById("regiaoFilter");
        if (regiaoSelReset) regiaoSelReset.value = "";
        const adesaoSelReset = document.getElementById("adesaoFilter");
        if (adesaoSelReset) adesaoSelReset.value = "";
        populateFilters();
        refreshAll();
        showToast(`Planilha carregada com sucesso: ${fmtInt(normalized.length)} municípios.`);
      } catch (err) {
        showToast("Não foi possível processar a planilha: " + err.message, true);
      }
    };
    reader.onerror = () => showToast("Erro ao ler o arquivo selecionado.", true);
    reader.readAsArrayBuffer(file);
  }

  /* ---------------- Wiring de eventos ---------------- */
  function wireEvents() {
    document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
      item.addEventListener("click", () => {
        goTo(item.getAttribute("data-view"));
        if (isMobileLayout()) closeSidebarMobile();
      });
    });

    const sidebarToggle = document.getElementById("sidebarToggle");
    if (sidebarToggle) sidebarToggle.addEventListener("click", toggleSidebar);
    const sidebarBackdrop = document.getElementById("sidebarBackdrop");
    if (sidebarBackdrop) sidebarBackdrop.addEventListener("click", closeSidebarMobile);

    const ufFilter = document.getElementById("ufFilter");
    if (ufFilter) {
      ufFilter.addEventListener("change", () => {
        // BUG#1: limpar o campo de município ao trocar de estado
        const globalSearchEl = document.getElementById("globalMunicipioFilter");
        if (globalSearchEl && globalSearchEl.value) {
          globalSearchEl.value = "";
          STATE.filters.search = "";
        }
        const suggestBox = document.getElementById("globalMunicipioSuggest");
        if (suggestBox) suggestBox.style.display = "none";
        STATE.filters.uf = ufFilter.value;
        refreshAll();
      });
    }

    const periodFilter = document.getElementById("periodFilter");
    if (periodFilter) periodFilter.addEventListener("change", () => { STATE.filters.periodo = periodFilter.value; refreshAll(); });

    const regiaoFilter = document.getElementById("regiaoFilter");
    if (regiaoFilter) regiaoFilter.addEventListener("change", () => { STATE.filters.regiao = regiaoFilter.value; refreshAll(); });

    const adesaoFilter = document.getElementById("adesaoFilter");
    if (adesaoFilter) adesaoFilter.addEventListener("change", () => { STATE.filters.adesao = adesaoFilter.value; refreshAll(); });

    const globalSearch = document.getElementById("globalMunicipioFilter");
    const suggestBox = document.getElementById("globalMunicipioSuggest");

    function renderMunicipioSuggestions() {
      if (!suggestBox) return;
      const uf = STATE.filters.uf;
      if (!uf) { suggestBox.style.display = "none"; suggestBox.innerHTML = ""; return; }
      const term = globalSearch.value.trim().toLowerCase();
      const matches = STATE.raw
        .filter((r) => r.uf === uf && (!term || r.m.toLowerCase().includes(term)))
        .sort((a, b) => a.m.localeCompare(b.m));
      if (!matches.length) {
        suggestBox.innerHTML = `<div class="autocomplete-empty">Nenhum município encontrado em ${escapeHtml(UF_NOME[uf] || uf)}.</div>`;
        suggestBox.style.display = "block";
        return;
      }
      suggestBox.innerHTML = matches.map((r) => `
        <div class="autocomplete-item" data-m="${escapeHtml(r.m)}">
          <span>${escapeHtml(r.m)}</span>
          <span class="autocomplete-tag ${r.ad ? "ok" : "no"}">${r.ad ? "Aderido" : "Sem adesão"}</span>
        </div>`).join("");
      suggestBox.style.display = "block";
      suggestBox.querySelectorAll(".autocomplete-item").forEach((item) => {
        item.addEventListener("click", () => {
          const mNome = item.getAttribute("data-m");
          const row = STATE.raw.find((r) => r.uf === uf && r.m === mNome);
          globalSearch.value = mNome;
          STATE.filters.search = mNome;
          suggestBox.style.display = "none";
          refreshAll();
          if (row) S.openMunicipioModal(row);
        });
      });
    }

    if (globalSearch) {
      globalSearch.addEventListener("input", debounce(() => {
        STATE.filters.search = globalSearch.value.trim();
        refreshAll();
      }, 320));
      globalSearch.addEventListener("input", renderMunicipioSuggestions);
      globalSearch.addEventListener("focus", renderMunicipioSuggestions);
      document.addEventListener("click", (e) => {
        if (suggestBox && !suggestBox.contains(e.target) && e.target !== globalSearch) {
          suggestBox.style.display = "none";
        }
      });
      globalSearch.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && suggestBox) suggestBox.style.display = "none";
      });
    }

    const tableSearch = document.getElementById("tableSearch");
    if (tableSearch) {
      const tableSearchHandler = debounce(() => {
        STATE.table.search = tableSearch.value.trim();
        STATE.table.page = 1;
        S.renderMunicipiosTable();
      }, 150);
      tableSearch.addEventListener("input", tableSearchHandler);
      tableSearch.addEventListener("keyup", tableSearchHandler);
    }

    const estadosSearch = document.getElementById("estadosSearch");
    if (estadosSearch) {
      const estadosSearchHandler = debounce(() => {
        STATE.estadosSearch = estadosSearch.value.trim();
        S.renderEstadosTable(STATE.lastAggEstados || STATE.lastAgg);
      }, 150);
      estadosSearch.addEventListener("input", estadosSearchHandler);
      estadosSearch.addEventListener("keyup", estadosSearchHandler);
    }

    const estadosSortKey = document.getElementById("estadosSortKey");
    if (estadosSortKey) {
      estadosSortKey.addEventListener("change", () => {
        if (!STATE.estadosSort) STATE.estadosSort = { key: "aderidos", dir: "desc" };
        const newKey = estadosSortKey.value;
        // BUG#18: nome e uf devem ter A→Z como padrão ao selecionar
        STATE.estadosSort.dir = (newKey === "nome" || newKey === "uf") ? "asc" : "desc";
        STATE.estadosSort.key = newKey;
        S.renderEstadosTable(STATE.lastAggEstados || STATE.lastAgg);
      });
    }
    const estadosSortDir = document.getElementById("estadosSortDir");
    if (estadosSortDir) {
      estadosSortDir.addEventListener("click", () => {
        if (!STATE.estadosSort) STATE.estadosSort = { key: "aderidos", dir: "desc" };
        STATE.estadosSort.dir = STATE.estadosSort.dir === "asc" ? "desc" : "asc";
        S.renderEstadosTable(STATE.lastAggEstados || STATE.lastAgg);
      });
    }

    const btnRefresh = document.getElementById("btnRefresh");
    if (btnRefresh) btnRefresh.addEventListener("click", () => { refreshAll(); showToast("Dados atualizados."); });

    // BUG#4: botão "Limpar filtros" — aparece quando qualquer filtro está ativo
    function updateFilterIndicator() {
      const btn = document.getElementById("btnLimparFiltros");
      if (!btn) return;
      const f = STATE.filters;
      const hasFilter = f.uf || f.regiao || f.adesao || f.periodo || f.search;
      btn.style.display = hasFilter ? "" : "none";
    }
    S.updateFilterIndicator = updateFilterIndicator;

    const btnLimpar = document.getElementById("btnLimparFiltros");
    if (btnLimpar) {
      btnLimpar.addEventListener("click", () => {
        STATE.filters = { uf: "", regiao: "", adesao: "", periodo: "", search: "" };
        document.getElementById("globalMunicipioFilter").value = "";
        document.getElementById("ufFilter").value = "";
        document.getElementById("regiaoFilter").value = "";
        document.getElementById("adesaoFilter").value = "";
        document.getElementById("periodFilter").value = "";
        const suggestBox = document.getElementById("globalMunicipioSuggest");
        if (suggestBox) suggestBox.style.display = "none";
        refreshAll();
        showToast("Filtros removidos.");
      });
    }

    const fileUpload = document.getElementById("fileUpload");
    if (fileUpload) fileUpload.addEventListener("change", (e) => { handleFileUpload(e.target.files[0]); e.target.value = ""; });
    const fileUpload2 = document.getElementById("fileUpload2");
    if (fileUpload2) fileUpload2.addEventListener("change", (e) => { handleFileUpload(e.target.files[0]); e.target.value = ""; });

    const btnGerar = document.getElementById("btnGerarRelatorio");
    if (btnGerar) {
      btnGerar.addEventListener("click", () => {
        const original = btnGerar.innerHTML;
        btnGerar.disabled = true;
        btnGerar.innerHTML = "Gerando relatório...";
        goTo("relatorios");
        setTimeout(() => {
          STATE.activeReportKind = "executivo";
          S.renderReport(STATE.lastAgg);
          btnGerar.disabled = false;
          btnGerar.innerHTML = original;
          const container = document.getElementById("reportContainer");
          if (container) container.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 30);
      });
    }

    const repTipo = document.getElementById("repTipo");
    if (repTipo) repTipo.addEventListener("change", () => {
      // BUG#12: limpar o relatório ativo ao trocar o tipo para não gerar automaticamente
      STATE.activeReportKind = null;
      const container = document.getElementById("reportContainer");
      if (container) container.innerHTML = "";
      updateRepFormVisibility();
    });

    const repEstado = document.getElementById("repEstado");
    if (repEstado) repEstado.addEventListener("change", () => populateRepMunicipioSelect(repEstado.value));

    const btnGerarDetalhado = document.getElementById("btnGerarRelatorioDetalhado");
    if (btnGerarDetalhado) {
      btnGerarDetalhado.addEventListener("click", () => {
        const tipo = document.getElementById("repTipo").value;
        const uf = document.getElementById("repEstado").value;
        if (!uf) { showToast("Selecione um estado.", true); return; }
        if (tipo === "municipio") {
          const mNome = document.getElementById("repMunicipio").value;
          if (!mNome) { showToast("Selecione um município.", true); return; }
        }
        const original = btnGerarDetalhado.innerHTML;
        btnGerarDetalhado.disabled = true;
        btnGerarDetalhado.innerHTML = "Gerando relatório...";
        setTimeout(() => {
          if (tipo === "municipio") {
            const mNome = document.getElementById("repMunicipio").value;
            const row = STATE.raw.find((r) => r.uf === uf && r.m === mNome);
            if (row) { STATE.activeReportKind = "municipio"; S.renderMunicipioReport(row); }
            else showToast("Município não encontrado.", true);
          } else if (tipo === "estado") {
            STATE.activeReportKind = "estado";
            S.renderEstadoReport(uf);
          } else if (tipo === "checklist") {
            const filtro = document.getElementById("repFiltroAdesao").value;
            STATE.activeReportKind = "checklist";
            S.renderChecklistReport(uf, filtro);
          } else if (tipo === "contatos") {
            const mNome = document.getElementById("repMunicipio").value;
            STATE.activeReportKind = "contatos";
            S.renderContatosReport(uf, mNome || null);
          }
          btnGerarDetalhado.disabled = false;
          btnGerarDetalhado.innerHTML = original;
          const container = document.getElementById("reportContainer");
          if (container) container.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 30);
      });
    }
    updateRepFormVisibility();

    const btnPdf = document.getElementById("btnExportPdf");
    if (btnPdf) btnPdf.addEventListener("click", () => S.exportPdfReport());
    const btnIrRelatorios = document.getElementById("btnIrParaRelatorios");
    if (btnIrRelatorios) btnIrRelatorios.addEventListener("click", () => goTo("relatorios"));

    const btnExcel = document.getElementById("btnExportExcel");
    if (btnExcel) btnExcel.addEventListener("click", () => S.exportExcel());

    const toggleLabels = document.getElementById("toggleMapLabels");
    if (toggleLabels) {
      toggleLabels.addEventListener("click", () => {
        STATE.mapLabels = !STATE.mapLabels;
        toggleLabels.classList.toggle("on", STATE.mapLabels);
        S.renderBrazilMap("brazilMap", "mapStatePanel", STATE.lastAgg);
        S.renderBrazilMap("brazilMap2", "mapStatePanel2", STATE.lastAgg);
      });
    }

    const cfgPageSize = document.getElementById("cfgPageSize");
    if (cfgPageSize) {
      cfgPageSize.addEventListener("change", () => {
        STATE.table.pageSize = parseInt(cfgPageSize.value, 10) || 25;
        STATE.table.page = 1;
        S.renderMunicipiosTable();
      });
    }

    const modalBackdrop = document.getElementById("modalBackdrop");
    if (modalBackdrop) {
      modalBackdrop.addEventListener("click", (e) => { if (e.target === modalBackdrop) S.closeModal(); });
    }
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { S.closeModal(); closeSidebarMobile(); } });
  }

  /* ---------------- Inicialização ---------------- */
  document.addEventListener("DOMContentLoaded", () => {
    STATE.raw = (typeof SNC_DEFAULT_DATA !== "undefined") ? SNC_DEFAULT_DATA : [];
    if (typeof SNC_DATA_META !== "undefined" && SNC_DATA_META.total) {
      STATE.sourceLabel = `Base oficial SNC (carregada automaticamente · ${fmtInt(SNC_DATA_META.total)} municípios)`;
    }
    populateFilters();
    wireEvents();
    initSidebarState();
    refreshAll();
    goTo("dashboard");
  });

  S.goTo = goTo;
  S.goToUF = goToUF;
  S.refreshAll = refreshAll;
  S.showToast = showToast;
})();

/* ============================================================================
   PARTE 8 — Relatórios Detalhados: Município, Estado e Checklist
   ============================================================================ */
(function () {
  "use strict";
  const S = window.__SNC;
  const { STATE, UF_NOME, COMPONENT_KEYS, COMPONENT_LABELS,
    fmtInt, fmtPct, fmtDate, escapeHtml } = S;

  const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  function fmtMesAno(iso) {
    if (!iso) return "—";
    const parts = iso.split("-");
    if (parts.length !== 3) return iso;
    const mIdx = parseInt(parts[1], 10) - 1;
    return `${MESES[mIdx] || parts[1]}/${parts[0]}`;
  }
  function atualizadoRecente(iso) {
    if (!iso) return false;
    const d = new Date(iso);
    const doisAnos = new Date();
    doisAnos.setFullYear(doisAnos.getFullYear() - 2);
    return d >= doisAnos;
  }

  /* ---------------- Status granular (badges) ---------------- */
  const STATUS_META = {
    "Concluída": { label: "Concluída", color: "green" },
    "Não informado(a)": { label: "Não informado", color: "gray" },
    "Avaliando anexo": { label: "Avaliando anexo", color: "blue" },
    "Arquivo incorreto": { label: "Arquivo incorreto", color: "red" },
    "Arquivo incompleto": { label: "Arquivo incompleto", color: "amber" },
    "Arquivo danificado": { label: "Arquivo danificado", color: "red" },
    "Em preenchimento": { label: "Em preenchimento", color: "amber" }
  };
  function statusBadge(st) {
    if (!st) return `<span class="status-badge gray">—</span>`;
    const meta = STATUS_META[st] || { label: st, color: "gray" };
    return `<span class="status-badge ${meta.color}">${meta.color === "green" ? "✓ " : ""}${meta.label}</span>`;
  }

  function filtroAdesaoLabel(f) {
    if (f === "aderidos") return "apenas municípios com adesão";
    if (f === "naoAderidos") return "apenas municípios sem adesão";
    return "todos os municípios";
  }

  function reportFooter() {
    return `
      <div style="margin-top:24px;padding-top:14px;border-top:1px solid var(--border);font-size:10.5px;color:var(--muted);text-align:center;">
        Iniciativa coordenada pelo SNC · Emitido pelo Chefe de Divisão Fagner Silva Ribeiro · Divisão SNC · Ministério da Cultura
      </div>`;
  }

  /* ---------------- Checklist de municípios (tabela reutilizável) ---------------- */
  function checklistTableHtml(rows, opts) {
    opts = opts || {};
    const showAdesao = opts.showAdesao !== false;
    if (!rows.length) {
      return `<div class="section-sub" style="margin:0;padding:20px 0;text-align:center;">Nenhum município encontrado para os filtros selecionados.</div>`;
    }
    return `
      <table class="report-table compact">
        <thead>
          <tr>
            <th>Município</th>
            ${showAdesao ? "<th>Situação</th>" : ""}
            <th>Atualização</th><th>Lei Sistema</th><th>Conselho (Lei)</th><th>Ata Conselho</th><th>Fundo</th><th>Plano</th><th>Órgão Gestor</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td><b>${escapeHtml(r.m)}</b></td>
              ${showAdesao ? `<td>${r.ad ? `<span class="status-badge green">✓ Aderido</span>` : `<span class="status-badge gray">Sem adesão</span>`}</td>` : ""}
              <td>${r.upd ? fmtDate(r.upd) : "—"}</td>
              <td>${statusBadge(r.sisSt)}</td>
              <td>${statusBadge(r.conSt)}</td>
              <td>${statusBadge(r.ataSt)}</td>
              <td>${statusBadge(r.funSt)}</td>
              <td>${statusBadge(r.plaSt)}</td>
              <td>${statusBadge(r.orgSt)}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  }

  /* ---------------- Nota técnica (gerada a partir dos dados reais do município) ---------------- */
  function gerarNotaTecnica(r) {
    const partes = [];
    const adesaoTxt = r.dtAd ? `Adesão desde ${fmtMesAno(r.dtAd)}` : "Sem registro de adesão";
    const updTxt = r.upd
      ? (atualizadoRecente(r.upd) ? ", com atualização cadastral recente" : `, sem atualização cadastral desde ${fmtMesAno(r.upd)}`)
      : ", sem registro de atualização cadastral";
    partes.push(adesaoTxt + updTxt + ".");

    const COMP_LABELS_SHORT = { sis: "Lei do Sistema", org: "Órgão Gestor", con: "Lei do Conselho", fun: "Fundo", pla: "Plano" };
    const concluidos = COMPONENT_KEYS.filter((k) => r[k] === 1).map((k) => COMP_LABELS_SHORT[k]);
    const pendentes = COMPONENT_KEYS.filter((k) => r[k] === 0).map((k) => COMP_LABELS_SHORT[k]);
    if (concluidos.length) partes.push(`${concluidos.join(" e ")} concluído${concluidos.length > 1 ? "s" : ""}.`);
    if (r.ataSt && r.ataSt !== "Concluída") {
      const ataLabel = (STATUS_META[r.ataSt] ? STATUS_META[r.ataSt].label : r.ataSt).toLowerCase();
      partes.push(`Ata do Conselho pendente (${ataLabel}).`);
    }
    if (pendentes.length) partes.push(`Pendências: ${pendentes.join(", ")} sem registro de conclusão.`);

    if (r.porte) {
      const nivel = r.idx <= 1 ? "baixo" : r.idx <= 3 ? "médio" : "alto";
      const grande = r.porte.indexOf("Porte 4") === 0 || r.porte.indexOf("Porte 5") === 0;
      const alerta = grande && r.idx <= 2 ? " — abaixo do esperado para seu porte" : "";
      partes.push(`Município de ${r.porte} (${r.pop ? fmtInt(r.pop) : "população não informada"}${r.pop ? " hab." : ""}) com nível ${nivel} de institucionalização${alerta}.`);
    }
    return partes.join(" ");
  }

  function conselhoDetail(r) {
    const parts = [];
    if (r.conData) parts.push("Lei de " + fmtDate(r.conData));
    const adj = [];
    if (r.conExcl) adj.push("exclusivo");
    if (r.conParit) adj.push("paritário");
    if (adj.length) parts.push(adj.join(", "));
    return parts.length ? parts.join(" — ") : "—";
  }

  /* ---------------- Relatório de Município ---------------- */
  function renderMunicipioReport(r) {
    const hoje = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
    const douPill = r.sit === "Publicado no DOU"
      ? `<span class="pill green"><span class="pill-dot" style="background:currentColor"></span>Publicado no DOU</span>`
      : r.ad
        ? `<span class="pill amber"><span class="pill-dot" style="background:currentColor"></span>${escapeHtml(r.sit)}</span>`
        : `<span class="pill red"><span class="pill-dot" style="background:currentColor"></span>Sem adesão ao SNC</span>`;

    const compRows = [
      { label: "Lei do Sistema Municipal de Cultura", badge: statusBadge(r.sisSt), detail: r.sisData ? fmtDate(r.sisData) : "—" },
      { label: "Órgão Gestor de Cultura", badge: statusBadge(r.orgSt), detail: [r.orgData ? "Lei de " + fmtDate(r.orgData) : null, r.orgPerfil].filter(Boolean).join(" — ") || "—" },
      { label: "Conselho de Política Cultural — Lei", badge: statusBadge(r.conSt), detail: conselhoDetail(r) },
      { label: "Conselho de Política Cultural — Ata", badge: statusBadge(r.ataSt), detail: r.ataData ? "Assinada em " + fmtDate(r.ataData) : (r.ataSt === "Em preenchimento" ? "Sem ata válida registrada" : "—") },
      { label: "Fundo Municipal de Cultura — Lei", badge: statusBadge(r.funSt), detail: r.funData ? fmtDate(r.funData) : "—" },
      { label: "Plano Municipal de Cultura", badge: statusBadge(r.plaSt), detail: r.planoData ? fmtDate(r.planoData) + (r.periodicidade ? " — " + r.periodicidade : "") : "—" },
      { label: "ACF incluído", badge: r.acf ? `<span class="status-badge green">✓ Sim</span>` : `<span class="status-badge gray">—</span>`, detail: "—" },
      { label: "Plano de Trabalho", badge: r.pt === "Aprovado" ? `<span class="status-badge green">✓ Aprovado</span>` : r.pt === "Rejeitado" ? `<span class="status-badge red">Rejeitado</span>` : `<span class="status-badge gray">—</span>`, detail: r.pt || "—" }
    ];

    const html = `
      <div class="report-page">
        <div class="report-header">
          <div>
            <div class="rh-title">Relatório de Institucionalização de ${escapeHtml(r.m)}/${r.uf} junto ao SNC</div>
            <div class="rh-sub">${escapeHtml(r.m)} · ${UF_NOME[r.uf] || r.uf} · Gerado em ${hoje}</div>
          </div>
          <div style="text-align:right;font-size:11px;color:var(--muted);">Lei nº 14.835/2024<br>Iniciativa coordenada pelo SNC</div>
        </div>

        <div class="grid grid-3" style="margin-bottom:18px;">
          <div class="card" style="padding:14px;">
            <div style="font-weight:800;font-size:18px;">${r.ad ? "Possui Adesão" : "Não possui Adesão"}</div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px;">${r.dtAd ? fmtDate(r.dtAd) : "—"}</div>
          </div>
          <div class="card" style="padding:14px;">
            <div style="font-weight:800;font-size:18px;">${r.idx}</div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px;">Componentes concluídos</div>
          </div>
          <div class="card" style="padding:14px;">
            <div style="font-weight:800;font-size:18px;">${r.upd ? fmtMesAno(r.upd) : "—"}</div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px;">Última atualização</div>
          </div>
        </div>

        <div class="report-section">
          <div style="background:var(--accent);color:#fff;padding:9px 14px;border-radius:8px;font-weight:700;font-size:13px;margin-bottom:10px;">${UF_NOME[r.uf] || r.uf} — ${escapeHtml(r.m)}</div>
          ${douPill}
        </div>

        <div class="detail-grid" style="margin-bottom:18px;">
          <div class="detail-item"><label>Gestor de Cultura</label><div>${escapeHtml(r.gestor || "Não informado")}</div></div>
          <div class="detail-item"><label>E-mail Gestor</label><div>${escapeHtml(r.emailGestor || "Não informado")}</div></div>
          <div class="detail-item"><label>Prefeito(a)</label><div>${escapeHtml(r.pref || "Não informado")}</div></div>
          <div class="detail-item"><label>E-mail Gabinete</label><div>${escapeHtml(r.emailPref || "Não informado")}</div></div>
        </div>

        <div class="report-section">
          <h3>Componentes do SNC</h3>
          <table class="report-table">
            <thead><tr><th>Componente</th><th>Situação</th><th>Detalhes / Data</th></tr></thead>
            <tbody>
              ${compRows.map((c) => `<tr><td>${c.label}</td><td>${c.badge}</td><td style="color:var(--muted);">${c.detail}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>

        <div class="report-section">
          <h3>Nota Técnica</h3>
          <div style="font-size:12.3px;line-height:1.6;color:var(--text);background:var(--surface-2);padding:14px 16px;border-radius:10px;">
            ${gerarNotaTecnica(r)}
          </div>
        </div>

        ${reportFooter()}
      </div>`;

    document.getElementById("reportContainer").innerHTML = html;
    STATE.reportOrientation = "portrait";
    STATE.reportFilename = `relatorio-${r.m.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-")}-${r.uf.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.pdf`;
  }

  /* ---------------- Relatório Estratégico de Estado ---------------- */
  function renderEstadoReport(uf) {
    const rows = STATE.raw.filter((r) => r.uf === uf);
    const aderidos = rows.filter((r) => r.ad);
    const naoAderidos = rows.length - aderidos.length;
    const pctCobertura = rows.length ? (aderidos.length / rows.length) * 100 : 0;
    const anoAtual = new Date().getFullYear();
    const atualizAnoAtual = aderidos.filter((r) => r.upd && r.upd.slice(0, 4) === String(anoAtual)).length;
    const atualizAnteriores = aderidos.length - atualizAnoAtual;

    const byYear = {};
    aderidos.forEach((r) => { if (r.dtAd) { const y = r.dtAd.slice(0, 4); byYear[y] = (byYear[y] || 0) + 1; } });
    const years = Object.keys(byYear).sort();
    let acc = 0;
    const evolucao = years.map((y) => { acc += byYear[y]; return { year: y, novo: byYear[y], acumulado: acc }; });
    const maxNovo = Math.max(1, ...evolucao.map((d) => d.novo));

    const compStats = {};
    COMPONENT_KEYS.forEach((k) => { compStats[k] = aderidos.reduce((s, r) => s + r[k], 0); });
    const COMP_LABEL_LONG = { sis: "Lei do Sistema Municipal de Cultura", con: "Conselho Municipal de Política Cultural", fun: "Fundo Municipal de Cultura", pla: "Plano Municipal de Cultura", org: "Órgão Gestor de Cultura" };

    const semAdesaoNomes = rows.filter((r) => !r.ad).map((r) => r.m).sort((a, b) => a.localeCompare(b));
    const aderidosOrdenados = aderidos.slice().sort((a, b) => a.m.localeCompare(b.m));

    const hoje = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });

    const html = `
      <div class="report-page">
        <div class="report-header">
          <div>
            <div class="rh-title">${UF_NOME[uf] || uf} — Evolução das Adesões ao Sistema Nacional de Cultura</div>
            <div class="rh-sub">Análise estratégica completa · Componentes Estruturantes · Gerado em ${hoje}</div>
          </div>
          <div style="text-align:right;font-size:11px;color:var(--muted);">Lei nº 14.835/2024<br>Iniciativa coordenada pelo SNC</div>
        </div>

        <div class="report-section">
          <h3>Indicadores Executivos</h3>
          <table class="report-table">
            <thead><tr><th>Indicador</th><th>Valor</th></tr></thead>
            <tbody>
              <tr><td>Total de municípios</td><td>${fmtInt(rows.length)}</td></tr>
              <tr><td>Com adesão ao SNC</td><td>${fmtInt(aderidos.length)} (${fmtPct(pctCobertura)})</td></tr>
              <tr><td>Sem adesão</td><td>${fmtInt(naoAderidos)} (${fmtPct(100 - pctCobertura)})</td></tr>
              <tr><td>Atualizações em ${anoAtual}</td><td>${fmtInt(atualizAnoAtual)}</td></tr>
              <tr><td>Atualizações em anos anteriores</td><td>${fmtInt(atualizAnteriores)}</td></tr>
            </tbody>
          </table>
        </div>

        <div class="report-section">
          <h3>Evolução das Adesões por Ano (Data Oficial)</h3>
          <table class="report-table">
            <thead><tr><th>Ano</th><th>Novas adesões</th><th>Acumulado</th><th></th></tr></thead>
            <tbody>
              ${evolucao.map((d) => `
                <tr>
                  <td><b>${d.year}</b></td>
                  <td>${fmtInt(d.novo)}</td>
                  <td>${fmtInt(d.acumulado)}</td>
                  <td style="width:35%;"><div style="background:var(--surface-2);border-radius:6px;height:9px;overflow:hidden;"><div style="background:var(--accent);height:100%;width:${((d.novo / maxNovo) * 100).toFixed(0)}%;"></div></div></td>
                </tr>`).join("") || `<tr><td colspan="4" style="text-align:center;color:var(--muted);">Sem histórico de adesões registrado.</td></tr>`}
            </tbody>
          </table>
        </div>

        <div class="report-section">
          <h3>Componentes Estruturantes do SNC</h3>
          ${COMPONENT_KEYS.map((k) => {
            const n = compStats[k];
            const pct = aderidos.length ? (n / aderidos.length) * 100 : 0;
            return `
              <div style="margin-bottom:14px;">
                <div style="display:flex;justify-content:space-between;font-size:12.5px;font-weight:600;margin-bottom:4px;">
                  <span>${COMP_LABEL_LONG[k]}</span><span>${fmtPct(pct)}</span>
                </div>
                <div style="background:var(--surface-2);border-radius:9999px;height:8px;overflow:hidden;">
                  <div style="background:${S.COMPONENT_COLORS[k]};height:100%;width:${pct}%;border-radius:9999px;"></div>
                </div>
                <div style="font-size:11px;color:var(--muted);margin-top:3px;">${fmtInt(n)} concluídos · ${fmtInt(aderidos.length - n)} não informados</div>
              </div>`;
          }).join("")}
        </div>

        <div class="report-section">
          <h3>Municípios Sem Adesão ao SNC (${fmtInt(semAdesaoNomes.length)})</h3>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            ${semAdesaoNomes.length ? semAdesaoNomes.map((m) => `<span class="status-badge gray">${escapeHtml(m)}</span>`).join("") : `<span style="color:var(--muted);font-size:12px;">Todos os municípios possuem adesão.</span>`}
          </div>
        </div>

        <div class="report-section">
          <h3>Municípios Com Adesão ao SNC (${fmtInt(aderidosOrdenados.length)})</h3>
          ${checklistTableHtml(aderidosOrdenados, { showAdesao: false })}
        </div>

        ${reportFooter()}
      </div>`;

    document.getElementById("reportContainer").innerHTML = html;
    STATE.reportOrientation = "landscape";
    STATE.reportFilename = `relatorio-estrategico-${uf.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.pdf`;
  }

  /* ---------------- Checklist de Municípios do Estado (lote) ---------------- */
  function renderChecklistReport(uf, filtro) {
    let rows = STATE.raw.filter((r) => r.uf === uf);
    if (filtro === "aderidos") rows = rows.filter((r) => r.ad);
    if (filtro === "naoAderidos") rows = rows.filter((r) => !r.ad);
    rows = rows.slice().sort((a, b) => a.m.localeCompare(b.m));

    const hoje = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });

    const html = `
      <div class="report-page">
        <div class="report-header">
          <div>
            <div class="rh-title">Checklist de Municípios — ${UF_NOME[uf] || uf}</div>
            <div class="rh-sub">Gerado em ${hoje} · ${fmtInt(rows.length)} municípios listados (${filtroAdesaoLabel(filtro)})</div>
          </div>
          <div style="text-align:right;font-size:11px;color:var(--muted);">Lei nº 14.835/2024<br>Iniciativa coordenada pelo SNC</div>
        </div>
        <div class="report-section">
          ${checklistTableHtml(rows, { showAdesao: filtro === "todos" })}
        </div>
        ${reportFooter()}
      </div>`;

    document.getElementById("reportContainer").innerHTML = html;
    STATE.reportOrientation = "landscape";
    STATE.reportFilename = `checklist-municipios-${uf.toLowerCase()}-${filtro}-${new Date().toISOString().slice(0, 10)}.pdf`;
  }

  /* ---------------- Lista de Contatos (Prefeito, Gestor, Cadastrador) ---------------- */
  function contatoCell(nome, email) {
    const nomeHtml = nome ? `<b>${escapeHtml(nome)}</b>` : `<span style="color:var(--muted);">Não informado</span>`;
    const emailHtml = email ? `<a href="mailto:${escapeHtml(email)}" style="color:var(--accent);text-decoration:none;">${escapeHtml(email)}</a>` : `<span style="color:var(--muted);">—</span>`;
    return `<td>${nomeHtml}</td><td>${emailHtml}</td>`;
  }

  function renderContatosReport(uf, municipioNome) {
    let rows = STATE.raw.filter((r) => r.uf === uf);
    if (municipioNome) rows = rows.filter((r) => r.m === municipioNome);
    rows = rows.slice().sort((a, b) => a.m.localeCompare(b.m));

    const semContato = rows.filter((r) => !r.pref && !r.gestor && !r.cad).length;
    const hoje = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
    const escopo = municipioNome ? `${municipioNome}/${uf}` : (UF_NOME[uf] || uf);

    const tableHtml = !rows.length
      ? `<div class="section-sub" style="margin:0;padding:20px 0;text-align:center;">Nenhum município encontrado.</div>`
      : `
      <table class="report-table compact">
        <thead>
          <tr>
            <th>Município</th>
            <th>Prefeito(a)</th><th>E-mail Gabinete</th>
            <th>Gestor de Cultura</th><th>E-mail Gestor</th>
            <th>Cadastrador</th><th>E-mail Cadastrador</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td><b>${escapeHtml(r.m)}</b>${!r.ad ? ` <span class="status-badge gray" style="margin-left:4px;">sem adesão</span>` : ""}</td>
              ${contatoCell(r.pref, r.emailPref)}
              ${contatoCell(r.gestor, r.emailGestor)}
              ${contatoCell(r.cad, r.emailCad)}
            </tr>`).join("")}
        </tbody>
      </table>`;

    const html = `
      <div class="report-page">
        <div class="report-header">
          <div>
            <div class="rh-title">Lista de Contatos — ${escapeHtml(escopo)}</div>
            <div class="rh-sub">Gerado em ${hoje} · ${fmtInt(rows.length)} município${rows.length === 1 ? "" : "s"} listado${rows.length === 1 ? "" : "s"}${semContato ? ` · ${fmtInt(semContato)} sem nenhum contato informado` : ""}</div>
          </div>
          <div style="text-align:right;font-size:11px;color:var(--muted);">Lei nº 14.835/2024<br>Iniciativa coordenada pelo SNC</div>
        </div>
        <div class="report-section">
          ${tableHtml}
        </div>
        ${reportFooter()}
      </div>`;

    document.getElementById("reportContainer").innerHTML = html;
    STATE.reportOrientation = "landscape";
    const sufixo = municipioNome ? municipioNome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-") : "todos";
    STATE.reportFilename = `contatos-${uf.toLowerCase()}-${sufixo}-${new Date().toISOString().slice(0, 10)}.pdf`;
  }

  S.statusBadge = statusBadge;
  S.checklistTableHtml = checklistTableHtml;
  S.renderMunicipioReport = renderMunicipioReport;
  S.renderEstadoReport = renderEstadoReport;
  S.renderChecklistReport = renderChecklistReport;
  S.renderContatosReport = renderContatosReport;
})();

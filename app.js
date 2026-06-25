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
  const COMPONENT_DATE_KEYS = {
    sis: "sisData", con: "conData", fun: "funData", pla: "planoData", org: "orgData"
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
    // Datas das leis dos componentes
    sisData: ["data da lei do sistema de cultura"],
    conData: ["data da lei do conselho de política cultural", "data da lei do conselho"],
    funData: ["data da lei do fundo de cultura", "data da lei do fundo"],
    planoData: ["data do plano de cultura"],
    orgData: ["data da lei do órgão gestor", "data da lei do orgao gestor"],
    upd: ["última atualização", "ultima atualizacao", "última atualizacao"],
    pt: ["situação do plano de trabalho"],
    acf: ["acf incluído", "acf incluido"],
    vig: ["último ano de vigência do plano de cultura", "ultimo ano de vigencia"],
    mon: ["plano monitorado"],
    pref: ["prefeito"],
    emailPref: ["email prefeito", "e-mail prefeito"],
    cad: ["cadastrador"],
    emailCad: ["email do cadastrador", "e-mail do cadastrador"],
    gestor: ["gestor de cultura"],
    emailGestor: ["email do gestor de cultura", "e-mail do gestor de cultura"],
    conParit: ["conselho paritário", "conselho paritario"],
    conExcl: ["conselho exclusivo de cultura"],
    conData2: ["data da lei do conselho de política cultural"],
    ataSt: ["situação da ata do conselho"],
    conAtaData: ["data da assinatura da ata"],
    siic: ["data siic"],
    porte: ["faixa populacional"],
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
      // Ignora linhas que representam o próprio Estado (entes estaduais)
      if (/^estado de /i.test(nome)) continue;
      // O DF aparece duplicado na planilha como "Brasília" (sem adesão) e "Distrito Federal"
      // (com adesão) — mantém apenas o Distrito Federal, descarta Brasília/DF duplicado
      if (ufRaw === "DF" && nome.toLowerCase() === "brasília") continue;

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
        porte: map.porte ? (r[map.porte] || null) : null,
        sit: aderiu ? (sitStr || "Publicado no DOU") : "Não possui adesão",
        ad: aderiu,
        dtAd: aderiu && map.dtAd ? parseBrDate(r[map.dtAd]) : null,
        sis, con, fun, pla, org, idx,
        // Datas das leis dos componentes
        sisData: map.sisData ? parseBrDate(r[map.sisData]) : null,
        conData: map.conData ? parseBrDate(r[map.conData]) : null,
        funData: map.funData ? parseBrDate(r[map.funData]) : null,
        planoData: map.planoData ? parseBrDate(r[map.planoData]) : null,
        orgData: map.orgData ? parseBrDate(r[map.orgData]) : null,
        // Status granular dos componentes
        sisSt: map.sis ? (r[map.sis] || null) : null,
        conSt: map.con ? (r[map.con] || null) : null,
        funSt: map.fun ? (r[map.fun] || null) : null,
        plaSt: map.pla ? (r[map.pla] || null) : null,
        orgSt: map.org ? (r[map.org] || null) : null,
        // Ata do conselho
        ataSt: map.ataSt ? (r[map.ataSt] || null) : null,
        conAta: null,
        conAtaData: map.conAtaData ? parseBrDate(r[map.conAtaData]) : null,
        conExcl: map.conExcl ? (String(r[map.conExcl] || "").toLowerCase() === "sim") : false,
        conParit: map.conParit ? (String(r[map.conParit] || "").toLowerCase() === "sim") : false,
        upd: map.upd ? parseBrDate(r[map.upd]) : null,
        pt: map.pt ? (r[map.pt] || null) : null,
        acf: map.acf ? truthyDone(r[map.acf]) : 0,
        vig: vigYear,
        venc: (pla === 1 && vigYear !== null && vigYear < new Date().getFullYear()) ? 1 : 0,
        mon: map.mon ? (String(r[map.mon] || "").toLowerCase().startsWith("sim") ? 1 : 0) : 0,
        pref: map.pref ? (r[map.pref] || null) : null,
        emailPref: map.emailPref ? (r[map.emailPref] || null) : null,
        cad: map.cad ? (r[map.cad] || null) : null,
        emailCad: map.emailCad ? (r[map.emailCad] || null) : null,
        gestor: map.gestor ? (r[map.gestor] || null) : null,
        emailGestor: map.emailGestor ? (r[map.emailGestor] || null) : null,
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
    // Bug #10: aderidos com 0 componentes implementados
    const aderidosSemComponentes = aderidos.filter((r) => r.idx === 0).length;
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
      alerts: { semPlano, semConselho, semFundo, planosVencidos, semAtualizacao2anos, piorEstado, aderidosSemComponentes },
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
  if (typeof Chart !== "undefined" && typeof ChartDataLabels !== "undefined") {
    Chart.register(ChartDataLabels);
    Chart.defaults.set("plugins.datalabels", { display: false });
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
    const base = aggBase || agg;
    const el = document.getElementById(containerId || "kpiRow");
    if (!el) return;
    const nUf = Object.keys(base.byUF).length;
    // Bug #4: label contextual baseado nos filtros ativos
    const f = STATE.filters;
    const contexto = f.uf ? "do total estadual" : f.regiao ? "do total regional" : "do total nacional";
    // Bug #5: quando filtro de ano está ativo, KPI mostra contexto diferente
    const anoAtivo = f.periodo;
    el.innerHTML = anoAtivo ? [
      kpiCardHtml({
        label: `Novas adesões em ${anoAtivo}`, value: fmtInt(base.aderidosCount), tone: "green", icon: ICONS.check,
        delta: `${fmtPct(base.total ? (base.aderidosCount / 5570) * 100 : 0)} do total de municípios brasileiros`, deltaTone: "up"
      }),
      kpiCardHtml({
        label: "Total de municípios no universo", value: fmtInt(base.total), tone: "blue", icon: ICONS.municipios,
        delta: `Municípios no contexto filtrado`, deltaTone: "flat"
      }),
      kpiCardHtml({
        label: "Índice médio (aderidos no ano)", value: fmtPct(base.indiceNacional), tone: "amber", icon: ICONS.gauge,
        delta: `Média dos 5 componentes do SNC`, deltaTone: "flat"
      }),
      kpiCardHtml({
        label: "Unidades federativas", value: fmtInt(nUf), tone: "blue", icon: ICONS.municipios,
        delta: `Com novas adesões em ${anoAtivo}`, deltaTone: "flat"
      })
    ].join("") : [
      kpiCardHtml({
        label: "Total de Municípios", value: fmtInt(base.total), tone: "blue", icon: ICONS.municipios,
        delta: `${fmtInt(nUf)} unidade${nUf === 1 ? "" : "s"} federativa${nUf === 1 ? "" : "s"}`, deltaTone: "flat"
      }),
      kpiCardHtml({
        label: "Municípios com Adesão", value: fmtInt(base.aderidosCount), tone: "green", icon: ICONS.check,
        delta: `${fmtPct(base.pctAderidos)} ${contexto}`, deltaTone: "up"
      }),
      kpiCardHtml({
        label: "Municípios sem Adesão", value: fmtInt(base.naoAderidos), tone: "red", icon: ICONS.x,
        delta: `${fmtPct(100 - base.pctAderidos)} ${contexto}`, deltaTone: "down"
      }),
      kpiCardHtml({
        label: "Aguardando publicação no DOU", value: fmtInt(base.situacaoCount && base.situacaoCount["Aguardando publicação no DOU"] || 0), tone: "amber", icon: ICONS.clock,
        delta: "Adesões em processamento", deltaTone: "flat"
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
          tooltip: { callbacks: { label: (ctx) => `${fmtInt(ctx.parsed.x)} municípios (${fmtPct(arr[ctx.dataIndex].pct)})` } },
          datalabels: { display: true, align: "right", anchor: "end", font: { size: 9.5, weight: "700" }, color: "#1d1d1f", formatter: (v, ctx) => `${fmtInt(v)} (${fmtPct(arr[ctx.dataIndex].pct)})`, padding: { left: 4 } }
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
          tooltip: { callbacks: { label: (ctx) => `${fmtPct(ctx.parsed.y)} concluído (${fmtInt(COMPONENT_KEYS.map(k=>agg.componentRates[k].n)[ctx.dataIndex])} municípios)` } },
          datalabels: { display: true, align: "top", anchor: "end", font: { size: 10, weight: "700" }, color: "#1d1d1f", formatter: (v) => fmtPct(v), padding: { bottom: 2 } }
        },
        scales: {
          y: { beginAtZero: true, max: 105, grid: { color: "#eef2f7" }, ticks: { callback: (v) => v + "%" } },
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
        // Na tela de Estados, abre o modal completo em vez do mini-painel
        if (STATE.currentView === "estados" && S.openEstadoModal) {
          S.openEstadoModal(uf, STATE.lastAggEstados || STATE.lastAgg);
          return;
        }
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
      tone: "red", icon: ICONS.doc, goto: "municipios",
      label: "Aderidos sem nenhum componente", sub: "Municípios com adesão mas sem implementação",
      value: fmtInt(a.aderidosSemComponentes || 0)
    }));
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
          <div class="estado-metric"><span class="estado-metric-label">Municípios</span><span class="estado-metric-value" aria-label="Total de municípios: ${fmtInt(r.total)}">${fmtInt(r.total)}</span></div>
          <div class="estado-metric"><span class="estado-metric-label">Aderidos</span><span class="estado-metric-value" aria-label="Municípios aderidos: ${fmtInt(r.aderidos)}">${fmtInt(r.aderidos)}</span></div>
          <div class="estado-metric"><span class="estado-metric-label">% Adesão</span><span class="estado-metric-value" style="color:${colorForPct(r.pct)};" aria-label="Percentual de adesão: ${fmtPct(r.pct)}">${fmtPct(r.pct)}</span></div>
          <div class="estado-metric"><span class="estado-metric-label">Índice médio</span><span class="estado-metric-value" aria-label="Índice médio de maturidade: ${r.idxMedio.toFixed(1)} de 5">${r.idxMedio.toFixed(1)} / 5</span></div>
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
    const b = (agg && agg.byUF) ? agg.byUF[uf] : null;
    const ed = (typeof SNC_ESTADOS_DATA !== "undefined" && SNC_ESTADOS_DATA[uf]) ? SNC_ESTADOS_DATA[uf] : null;
    const municipiosUF = (STATE.raw || []).filter((r) => r.uf === uf);
    const aderidos = municipiosUF.filter((r) => r.ad);
    const semAdesao = municipiosUF.filter((r) => !r.ad);

    // Só funciona na tela de Estados (painel inline)
    const panel = document.getElementById("estadoReportPanel");
    const headerEl = document.getElementById("estadoReportHeader");
    const bodyEl = document.getElementById("estadoReportBody");
    if (!panel || !headerEl || !bodyEl) return;

    const nomeEstado = (ed && ed.nome) ? ed.nome : (UF_NOME[uf] || uf);
    const hoje = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });

    // ── Helper ──────────────────────────────────────────────────────────────
    function pill(label, tone) {
      const colors = {
        blue: "background:rgba(0,122,255,.12);color:#007aff;border-color:rgba(0,122,255,.25);",
        green: "background:rgba(52,199,89,.12);color:#16a34a;border-color:rgba(52,199,89,.25);",
        red: "background:rgba(220,38,38,.1);color:#dc2626;border-color:rgba(220,38,38,.2);",
        amber: "background:rgba(245,158,11,.12);color:#d97706;border-color:rgba(245,158,11,.25);",
        gray: "background:var(--surface);color:var(--muted);border-color:var(--border);"
      };
      return `<span style="display:inline-flex;align-items:center;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:4px 12px;border-radius:9999px;border:1px solid;${colors[tone] || colors.gray}">${label}</span>`;
    }
    function kpi(label, value, tone, sub) {
      const barColors = { blue:"#007aff", green:"#16a34a", red:"#dc2626", amber:"#d97706", purple:"#9333ea", teal:"#0ea5e9" };
      const txtColors = { blue:"color:#007aff", green:"color:#16a34a", red:"color:#dc2626", amber:"color:#d97706", purple:"color:#9333ea", teal:"color:#0ea5e9" };
      return `<div class="card" style="padding:18px 20px 16px;position:relative;overflow:hidden;">
        <div style="position:absolute;top:0;left:0;right:0;height:3px;border-radius:14px 14px 0 0;background:${barColors[tone] || "#6e6e73"};"></div>
        <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">${label}</div>
        <div style="font-size:2rem;font-weight:800;letter-spacing:-.04em;line-height:1;${txtColors[tone] || ""}">${value}</div>
        ${sub ? `<div style="font-size:11px;color:var(--muted);margin-top:6px;">${sub}</div>` : ""}
      </div>`;
    }
    function secTitle(label) {
      return `<div style="display:flex;align-items:baseline;gap:16px;margin:28px 0 16px;">
        <span style="font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);white-space:nowrap;">${label}</span>
        <div style="flex:1;height:1px;background:var(--border);"></div>
      </div>`;
    }
    function compRow(label, done, st, dt) {
      const icon = done
        ? `<svg viewBox="0 0 24 24" fill="none" width="18" height="18" style="color:#16a34a;flex-shrink:0;"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" width="18" height="18" style="color:var(--muted);flex-shrink:0;"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v4M12 16h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
      return `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);">
        ${icon}
        <span style="flex:1;font-weight:600;font-size:13px;">${label}</span>
        <span style="font-size:12px;color:${done ? "#16a34a" : "var(--muted)"};">${st || "—"}</span>
        ${dt ? `<span style="font-size:11px;color:var(--muted);margin-left:8px;">${fmtDate(dt)}</span>` : ""}
      </div>`;
    }

    // ── HEADER ───────────────────────────────────────────────────────────────
    const pctAd = b ? fmtPct(b.pct) : "—";
    headerEl.innerHTML = `
      <div style="font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.55);margin-bottom:10px;">
        Ministério da Cultura · SAFCC · DSNC-SNC · Relatório Estratégico
      </div>
      <div style="font-size:1.6rem;font-weight:800;letter-spacing:-.03em;line-height:1.1;margin-bottom:6px;">
        ${nomeEstado} — Sistema Nacional de Cultura
      </div>
      <div style="font-size:12px;color:rgba(255,255,255,.65);margin-bottom:16px;">
        Análise completa · Estado como ente federado e municípios · Referência ${hoje}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
        ${pill("Lei nº 14.835/2024", "blue")}
        ${b ? pill(`${fmtInt(b.total)} municípios`, "gray") : ""}
        ${b ? pill(`${pctAd} de cobertura`, "green") : ""}
        ${b ? pill(`${fmtInt(b.total - b.aderidos)} sem adesão`, "red") : ""}
        ${ed && ed.sit ? pill(ed.sit, "blue") : ""}
      </div>
      <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap;">
        <button id="btnEstadoReportPrint" style="display:inline-flex;align-items:center;gap:7px;padding:8px 18px;border-radius:9999px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;">
          <svg viewBox="0 0 24 24" fill="none" width="14" height="14"><path d="M6 9V3h12v6M6 18H4a1 1 0 01-1-1v-6a1 1 0 011-1h16a1 1 0 011 1v6a1 1 0 01-1 1h-2" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M6 14h12v7H6v-7z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
          Imprimir
        </button>
        <button id="btnEstadoReportPdf" style="display:inline-flex;align-items:center;gap:7px;padding:8px 18px;border-radius:9999px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;">
          <svg viewBox="0 0 24 24" fill="none" width="14" height="14"><path d="M7 3h7l5 5v13H7V3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 13h4M10 16h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          Exportar PDF
        </button>
        <button id="btnEstadoReportVerMun" style="display:inline-flex;align-items:center;gap:7px;padding:8px 18px;border-radius:9999px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;">
          Ver municípios
        </button>
        <button id="btnEstadoReportFechar" style="display:inline-flex;align-items:center;gap:7px;padding:8px 18px;border-radius:9999px;border:1px solid rgba(255,255,255,.2);background:transparent;color:rgba(255,255,255,.6);font-size:12.5px;font-weight:600;cursor:pointer;">
          ✕ Fechar
        </button>
      </div>`;

    // ── BODY ─────────────────────────────────────────────────────────────────
    // Bloco 1: Estado como ente federado
    const blocoEnte = ed ? `
      ${secTitle("Estado como Ente Federado")}
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:20px;">
        ${kpi("Situação", ed.sit || "—", ed.sit === "Publicado no DOU" ? "green" : "amber", ed.dtAd ? `Adesão: ${fmtDate(ed.dtAd)}` : null)}
        ${kpi("Vigência do Plano", ed.vig ? String(ed.vig) : "—", ed.vig && ed.vig >= new Date().getFullYear() ? "green" : "red", ed.plaPeriodicidade || null)}
        ${kpi("Componentes concluídos", `${[ed.sis,ed.org,ed.con,ed.fun,ed.pla].filter(x=>x===1).length} / 5`, "blue", "Estado como ente federado")}
        ${kpi("Última atualização", ed.upd ? fmtDate(ed.upd) : "—", "gray", null)}
      </div>
      <div style="margin-bottom:20px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:8px;">Componentes do Estado</div>
        ${compRow("Sistema Estadual de Cultura", ed.sis===1, ed.sisSt, ed.sisData)}
        ${compRow("Órgão Gestor de Cultura", ed.org===1, ed.orgSt + (ed.orgPerfil ? " · " + ed.orgPerfil : ""), ed.orgData)}
        ${compRow("Conselho Estadual de Política Cultural", ed.con===1, ed.conSt + (ed.conNatureza ? " · " + ed.conNatureza : "") + (ed.conExcl ? " · Exclusivo" : "") + (ed.conParit ? " · Paritário" : ""), ed.conData)}
        ${compRow("Fundo Estadual de Cultura", ed.fun===1, ed.funSt, ed.funData)}
        ${compRow("Plano Estadual de Cultura", ed.pla===1, ed.plaSt + (ed.plaMetas !== null ? (ed.plaMetas ? " · Com metas" : " · Sem metas") : ""), ed.plaData)}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-bottom:8px;">
        <div class="card" style="padding:16px 18px;">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:10px;">Governador / Representante</div>
          <div style="font-weight:700;font-size:13.5px;">${ed.governador || "Não informado"}</div>
          ${ed.emailGov ? `<div style="font-size:12px;color:var(--accent);margin-top:4px;"><a href="mailto:${ed.emailGov}" style="color:var(--accent);">${ed.emailGov}</a></div>` : ""}
          ${ed.tel ? `<div style="font-size:12px;color:var(--muted);margin-top:3px;">Tel: ${ed.tel}</div>` : ""}
        </div>
        <div class="card" style="padding:16px 18px;">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:10px;">Gestor Estadual de Cultura</div>
          <div style="font-weight:700;font-size:13.5px;">${ed.gestor || "Não informado"}</div>
          ${ed.emailGestor ? `<div style="font-size:12px;color:var(--accent);margin-top:4px;"><a href="mailto:${ed.emailGestor}" style="color:var(--accent);">${ed.emailGestor}</a></div>` : ""}
        </div>
        <div class="card" style="padding:16px 18px;">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:10px;">Cadastrador Estadual</div>
          <div style="font-weight:700;font-size:13.5px;">${ed.cad || "Não informado"}</div>
          ${ed.emailCad ? `<div style="font-size:12px;color:var(--accent);margin-top:4px;"><a href="mailto:${ed.emailCad}" style="color:var(--accent);">${ed.emailCad}</a></div>` : ""}
        </div>
      </div>
      ${ed.sei ? `<div style="font-size:11px;color:var(--muted);margin-top:8px;">Nº Processo SEI: ${ed.sei}</div>` : ""}
    ` : "";

    // Bloco 2: Municípios do estado
    const aguardandoDOU = municipiosUF.filter((r) => r.sit === "Aguardando publicação no DOU").length;

    const compRatesMun = b ? [
      { label: "Sistema Municipal", n: b.sis, pct: b.aderidos ? (b.sis/b.aderidos)*100 : 0, color: "#007aff" },
      { label: "Conselho", n: b.con, pct: b.aderidos ? (b.con/b.aderidos)*100 : 0, color: "#16a34a" },
      { label: "Fundo de Cultura", n: b.fun, pct: b.aderidos ? (b.fun/b.aderidos)*100 : 0, color: "#9333ea" },
      { label: "Plano de Cultura", n: b.pla, pct: b.aderidos ? (b.pla/b.aderidos)*100 : 0, color: "#d97706" },
      { label: "Órgão Gestor", n: b.org, pct: b.aderidos ? (b.org/b.aderidos)*100 : 0, color: "#0ea5e9" },
    ] : [];

    const barrasComp = compRatesMun.map((c) => `
      <div style="margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:5px;">
          <span style="font-size:12.5px;font-weight:600;">${c.label}</span>
          <span style="font-size:12px;font-weight:700;color:${c.color};">${fmtInt(c.n)} (${fmtPct(c.pct)})</span>
        </div>
        <div style="height:8px;background:var(--surface);border-radius:9999px;overflow:hidden;border:1px solid var(--border);">
          <div style="height:100%;width:${Math.min(c.pct,100).toFixed(1)}%;background:${c.color};border-radius:9999px;transition:width .4s;"></div>
        </div>
        <div style="font-size:10.5px;color:var(--muted);margin-top:3px;">de ${fmtInt(b.aderidos)} municípios aderidos</div>
      </div>`).join("");

    const semAdesaoList = semAdesao.slice().sort((a,b_)=>a.m.localeCompare(b_.m,"pt-BR")).map((r) =>
      `<div style="padding:5px 0;border-bottom:1px solid var(--border);font-size:12.5px;display:flex;align-items:center;gap:8px;">
        <span style="font-weight:600;">${escapeHtml(r.m)}</span>
        ${r.upd ? `<span style="font-size:11px;color:var(--muted);margin-left:auto;">Atualizado: ${fmtDate(r.upd)}</span>` : ""}
      </div>`).join("");

    const blocoMunicipios = b ? `
      ${secTitle("Municípios do Estado · Panorama")}
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:20px;">
        ${kpi("Total de municípios", fmtInt(b.total), "blue", "Universo do estado")}
        ${kpi("Com adesão ao SNC", fmtInt(b.aderidos), "green", `${fmtPct(b.pct)} de cobertura`)}
        ${kpi("Sem adesão", fmtInt(b.total - b.aderidos), "red", `${fmtPct(100 - b.pct)} do universo`)}
        ${kpi("Aguardando publicação no DOU", fmtInt(aguardandoDOU), "amber", "Adesões em processamento")}
        ${kpi("Índice médio de maturidade", `${b.idxMedio.toFixed(1)} / 5`, "amber", "Média dos componentes")}
      </div>
      ${secTitle("Componentes Estruturantes — Municípios Aderidos")}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:20px;">
        <div>${barrasComp}</div>
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:10px;">Distribuição por nº de componentes</div>
          ${[0,1,2,3,4,5].map((i) => {
            const cnt = agg && agg.donut ? (agg.donut[i] || 0) : 0;
            const colors = ["#dc2626","#f08c3a","#f2c94c","#3fae6b","#16a34a","#0a6e3a"];
            return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <span style="width:10px;height:10px;border-radius:50%;background:${colors[i]};flex-shrink:0;"></span>
              <span style="font-size:12px;flex:1;">${i} componente${i===1?"":"s"}</span>
              <span style="font-weight:700;font-size:13px;">${fmtInt(cnt)}</span>
            </div>`;
          }).join("")}
        </div>
      </div>
      ${semAdesao.length ? `
        ${secTitle(`Municípios Sem Adesão · ${fmtInt(semAdesao.length)}`)}
        <div style="columns:2;column-gap:24px;margin-bottom:8px;">${semAdesaoList}</div>
      ` : ""}
    ` : "";

    bodyEl.innerHTML = blocoEnte + blocoMunicipios +
      `<div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--border);font-size:11px;color:var(--muted);text-align:center;">
        Iniciativa coordenada pelo SNC · Emitido pelo Chefe de Divisão Fagner Silva Ribeiro · Divisão SNC · Ministério da Cultura
      </div>`;

    panel.style.display = "";
    panel.scrollIntoView({ behavior: "smooth", block: "start" });

    // ── Botões ────────────────────────────────────────────────────────────────
    document.getElementById("btnEstadoReportFechar").addEventListener("click", () => {
      panel.style.display = "none";
    });
    document.getElementById("btnEstadoReportVerMun").addEventListener("click", () => {
      panel.style.display = "none";
      window.__SNC.goToUF(uf);
    });
    document.getElementById("btnEstadoReportPrint").addEventListener("click", () => {
      document.body.classList.add("printing-estado-report");
      const cleanup = () => document.body.classList.remove("printing-estado-report");
      window.addEventListener("afterprint", cleanup, { once: true });
      window.print();
      setTimeout(cleanup, 2000);
    });
    document.getElementById("btnEstadoReportPdf").addEventListener("click", () => {
      if (typeof html2pdf === "undefined") return;
      const el = panel.querySelector(".card");
      const opt = {
        margin: [8, 8, 8, 8],
        filename: `estado-${uf.toLowerCase()}-snc-${new Date().toISOString().slice(0,10)}.pdf`,
        image: { type: "jpeg", quality: 0.97 },
        html2canvas: { scale: 2, useCORS: true, scrollX: 0, scrollY: 0 },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["css", "legacy"] }
      };
      html2pdf().set(opt).from(el).save();
    });
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
  function closeModal() {
    const backdrop = document.getElementById("modalBackdrop");
    if (!backdrop) return;
    backdrop.classList.remove("open");
    const modalBox = backdrop.querySelector(".modal");
    if (modalBox) {
      modalBox.style.maxWidth = "";
      modalBox.style.width = "";
      modalBox.style.maxHeight = "";
      modalBox.style.padding = "";
      modalBox.style.overflow = "";
    }
  }

  function openMunicipioModal(r) {
    const backdrop = document.getElementById("modalBackdrop");
    const modalContent = document.getElementById("modalContent");
    if (!backdrop || !modalContent) return;

    const UF = r.uf || "";
    const regiao = r.reg || "";
    const hoje = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
    const aguardandoDOU = r.sit === "Aguardando publicação no DOU";

    // Situação badge
    function sitBadge(sit) {
      if (!sit) return "";
      const s = sit.toLowerCase();
      const tone = s.includes("publicado no dou") ? "#16a34a"
        : s.includes("aguardando") ? "#d97706"
        : s.includes("diligência") ? "#0ea5e9"
        : "#6e6e73";
      return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:700;color:${tone};background:${tone}18;border:1px solid ${tone}40;padding:4px 12px;border-radius:9999px;">${escapeHtml(sit)}</span>`;
    }

    // Componente row com data
    function compRowMun(label, done, dt, st) {
      const icon = done
        ? `<svg viewBox="0 0 24 24" fill="none" width="17" height="17" style="color:#16a34a;flex-shrink:0;"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" width="17" height="17" style="color:var(--muted);flex-shrink:0;"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v4M12 16h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
      return `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);">
        ${icon}
        <span style="flex:1;font-weight:600;font-size:13px;">${label}</span>
        <span style="font-size:11.5px;color:${done ? "#16a34a" : "var(--muted)"};">${st || (done ? "Concluída" : "Pendente")}</span>
        ${done && dt ? `<span style="font-size:11px;color:var(--muted);margin-left:8px;">${fmtDate(dt)}</span>` : ""}
      </div>`;
    }

    // Card de contato
    function contactCard(label, name, email, extra) {
      if (!name) return "";
      return `<div class="card" style="padding:14px 16px;">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:8px;">${label}</div>
        <div style="font-weight:700;font-size:13px;">${escapeHtml(name)}</div>
        ${email ? `<div style="font-size:11.5px;margin-top:4px;"><a href="mailto:${escapeHtml(email)}" style="color:var(--accent);">${escapeHtml(email)}</a></div>` : ""}
        ${extra ? `<div style="font-size:11px;color:var(--muted);margin-top:3px;">${extra}</div>` : ""}
      </div>`;
    }

    const idxLabel = ["Crítico","Muito Baixo","Baixo","Médio","Alto","Completo"][r.idx] || "—";
    const idxColor = ["#dc2626","#f08c3a","#f2c94c","#3fae6b","#16a34a","#0a6e3a"][r.idx] || "var(--muted)";

    modalContent.innerHTML = `
      <!-- HEADER ESCURO -->
      <div style="background:var(--sidebar-bg,#1c1c1e);color:#fff;padding:24px 28px 20px;border-radius:0;">
        <div style="font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.5);margin-bottom:8px;">
          Ministério da Cultura · SAFCC · DSNC-SNC · Ficha Municipal
        </div>
        <div style="font-size:1.4rem;font-weight:800;letter-spacing:-.02em;line-height:1.1;margin-bottom:6px;">
          ${escapeHtml(r.m)} — ${UF_NOME[UF] || UF}
        </div>
        <div style="font-size:12px;color:rgba(255,255,255,.6);margin-bottom:14px;">
          ${regiao} · IBGE ${r.ibge || "—"} · Referência ${hoje}
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px;">
          ${sitBadge(r.sit)}
          ${r.ad ? `<span style="font-size:11px;font-weight:600;color:rgba(255,255,255,.7);background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);padding:4px 12px;border-radius:9999px;">${r.idx}/5 componentes · ${idxLabel}</span>` : ""}
          ${r.porte ? `<span style="font-size:11px;color:rgba(255,255,255,.6);background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);padding:4px 12px;border-radius:9999px;">${escapeHtml(String(r.porte))}</span>` : ""}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="munRepPrintBtn" style="display:inline-flex;align-items:center;gap:6px;padding:7px 16px;border-radius:9999px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;font-size:12px;font-weight:600;cursor:pointer;">
            <svg viewBox="0 0 24 24" fill="none" width="13" height="13"><path d="M6 9V3h12v6M6 18H4a1 1 0 01-1-1v-6a1 1 0 011-1h16a1 1 0 011 1v6a1 1 0 01-1 1h-2" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M6 14h12v7H6v-7z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
            Imprimir
          </button>
          <button id="munRepPdfBtn" style="display:inline-flex;align-items:center;gap:6px;padding:7px 16px;border-radius:9999px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;font-size:12px;font-weight:600;cursor:pointer;">
            <svg viewBox="0 0 24 24" fill="none" width="13" height="13"><path d="M7 3h7l5 5v13H7V3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 13h4M10 16h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            Exportar PDF
          </button>
          <button id="modalCloseBtn" style="display:inline-flex;align-items:center;gap:6px;padding:7px 16px;border-radius:9999px;border:1px solid rgba(255,255,255,.2);background:transparent;color:rgba(255,255,255,.6);font-size:12px;font-weight:600;cursor:pointer;">
            ✕ Fechar
          </button>
        </div>
      </div>

      <!-- CORPO DO RELATÓRIO -->
      <div id="munRepBody" style="padding:24px 28px 28px;">

        <!-- KPIs -->
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:20px;">
          <div class="card" style="padding:14px 16px;position:relative;overflow:hidden;">
            <div style="position:absolute;top:0;left:0;right:0;height:3px;background:${r.ad ? "#16a34a" : "#6e6e73"};border-radius:14px 14px 0 0;"></div>
            <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;">Situação da adesão</div>
            <div style="font-size:13px;font-weight:700;color:${r.ad ? "#16a34a" : "var(--muted)"};">${r.ad ? "Possui adesão" : "Sem adesão"}</div>
            ${r.dtAd ? `<div style="font-size:11px;color:var(--muted);margin-top:4px;">Desde ${fmtDate(r.dtAd)}</div>` : ""}
          </div>
          ${aguardandoDOU ? `
          <div class="card" style="padding:14px 16px;position:relative;overflow:hidden;border-color:#d97706;">
            <div style="position:absolute;top:0;left:0;right:0;height:3px;background:#d97706;border-radius:14px 14px 0 0;"></div>
            <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;">Publicação no DOU</div>
            <div style="font-size:13px;font-weight:700;color:#d97706;">Aguardando</div>
            <div style="font-size:11px;color:var(--muted);margin-top:4px;">Adesão em processamento</div>
          </div>` : ""}
          <div class="card" style="padding:14px 16px;position:relative;overflow:hidden;">
            <div style="position:absolute;top:0;left:0;right:0;height:3px;background:${idxColor};border-radius:14px 14px 0 0;"></div>
            <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;">Índice de maturidade</div>
            <div style="font-size:1.5rem;font-weight:800;color:${idxColor};">${r.idx} / 5</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px;">${idxLabel}</div>
          </div>
          <div class="card" style="padding:14px 16px;position:relative;overflow:hidden;">
            <div style="position:absolute;top:0;left:0;right:0;height:3px;background:#007aff;border-radius:14px 14px 0 0;"></div>
            <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;">Última atualização</div>
            <div style="font-size:13px;font-weight:700;">${r.upd ? fmtDate(r.upd) : "Não informado"}</div>
          </div>
          ${r.vig ? `
          <div class="card" style="padding:14px 16px;position:relative;overflow:hidden;">
            <div style="position:absolute;top:0;left:0;right:0;height:3px;background:${r.vig >= new Date().getFullYear() ? "#16a34a" : "#dc2626"};border-radius:14px 14px 0 0;"></div>
            <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;">Vigência do Plano</div>
            <div style="font-size:1.3rem;font-weight:800;color:${r.vig >= new Date().getFullYear() ? "#16a34a" : "#dc2626"};">${r.vig}</div>
            <div style="font-size:11px;color:var(--muted);">${r.vig >= new Date().getFullYear() ? "Em vigor" : "Vencido"}</div>
          </div>` : ""}
        </div>

        <!-- Componentes -->
        <div style="margin-bottom:20px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:8px;display:flex;align-items:center;gap:12px;">
            Checklist de componentes do SNC
            <div style="flex:1;height:1px;background:var(--border);"></div>
          </div>
          ${compRowMun("Sistema Municipal de Cultura", !!r.sis, r.sisData, r.sisSt)}
          ${compRowMun("Conselho de Política Cultural", !!r.con, r.conData, r.conSt)}
          ${compRowMun("Fundo de Cultura", !!r.fun, r.funData, r.funSt)}
          ${compRowMun("Plano de Cultura", !!r.pla, r.planoData, r.plaSt)}
          ${compRowMun("Órgão Gestor de Cultura", !!r.org, r.orgData, r.orgSt)}
        </div>

        <!-- Contatos -->
        <div style="margin-bottom:20px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:10px;display:flex;align-items:center;gap:12px;">
            Contatos
            <div style="flex:1;height:1px;background:var(--border);"></div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;">
            ${contactCard("Prefeito(a)", r.pref, r.emailPref, null)}
            ${contactCard("Gestor de Cultura", r.gestor, r.emailGestor, null)}
            ${contactCard("Cadastrador", r.cad, r.emailCad, null)}
          </div>
        </div>

        <!-- Dados adicionais -->
        ${(r.pt || r.acf || r.siic) ? `
        <div style="margin-bottom:16px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:10px;display:flex;align-items:center;gap:12px;">
            Informações adicionais
            <div style="flex:1;height:1px;background:var(--border);"></div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;">
            ${r.pt ? `<div class="card" style="padding:12px 14px;"><div style="font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;margin-bottom:4px;">Plano de Trabalho</div><div style="font-size:12.5px;font-weight:600;">${escapeHtml(r.pt)}</div></div>` : ""}
            ${r.acf ? `<div class="card" style="padding:12px 14px;"><div style="font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;margin-bottom:4px;">ACF Incluído</div><div style="font-size:12.5px;font-weight:600;color:#16a34a;">Sim</div></div>` : ""}
            ${r.siic ? `<div class="card" style="padding:12px 14px;"><div style="font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;margin-bottom:4px;">SIIC</div><div style="font-size:12.5px;font-weight:600;color:#16a34a;">Inscrito</div></div>` : ""}
          </div>
        </div>` : ""}

        <div style="padding-top:16px;border-top:1px solid var(--border);font-size:11px;color:var(--muted);text-align:center;">
          Iniciativa coordenada pelo SNC · Emitido pelo Chefe de Divisão Fagner Silva Ribeiro · Divisão SNC · Ministério da Cultura
        </div>
      </div>`;

    // Ajustar o modal para ser maior
    const modalBox = backdrop.querySelector(".modal");
    if (modalBox) {
      modalBox.style.maxWidth = "860px";
      modalBox.style.width = "92vw";
      modalBox.style.maxHeight = "90vh";
      modalBox.style.padding = "0";
      modalBox.style.overflow = "hidden auto";
    }

    backdrop.classList.add("open");

    document.getElementById("modalCloseBtn").addEventListener("click", closeModal);

    document.getElementById("munRepPrintBtn").addEventListener("click", () => {
      document.body.classList.add("printing-modal");
      const cleanup = () => document.body.classList.remove("printing-modal");
      window.addEventListener("afterprint", cleanup, { once: true });
      window.print();
      setTimeout(cleanup, 2000);
    });

    document.getElementById("munRepPdfBtn").addEventListener("click", () => {
      if (typeof html2pdf === "undefined") return;
      const slug = (r.m || "municipio").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      const hoje = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
      const idxLabel = ["Crítico","Muito Baixo","Baixo","Médio","Alto","Completo"][r.idx] || "—";
      const idxColor = ["#dc2626","#f08c3a","#f2c94c","#3fae6b","#16a34a","#0a6e3a"][r.idx] || "#6e6e73";

      // Monta container completo para o PDF com header imprimível
      let container = document.getElementById("munPdfContainer");
      if (!container) {
        container = document.createElement("div");
        container.id = "munPdfContainer";
        container.style.cssText = "position:fixed;left:-9999px;top:0;width:800px;font-family:Inter,sans-serif;background:#fff;";
        document.body.appendChild(container);
      }

      // Copia o corpo do relatório
      const bodyHtml = document.getElementById("munRepBody").innerHTML;

      container.innerHTML = `
        <div style="background:#007aff;color:#fff;padding:24px 28px 20px;">
          <div style="font-size:9px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.5);margin-bottom:8px;">
            Ministério da Cultura · SAFCC · DSNC-SNC · Ficha Municipal
          </div>
          <div style="font-size:22px;font-weight:800;line-height:1.1;margin-bottom:6px;color:#fff;">
            ${escapeHtml(r.m)} — ${UF_NOME[r.uf] || r.uf || ""}
          </div>
          <div style="font-size:11px;color:rgba(255,255,255,.65);margin-bottom:12px;">
            ${r.reg || ""} · IBGE ${r.ibge || "—"} · Referência ${hoje}
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
            <span style="font-size:10px;font-weight:700;color:${r.ad ? "#4ade80" : "#9ca3af"};background:${r.ad ? "rgba(74,222,128,.15)" : "rgba(156,163,175,.1)"};border:1px solid ${r.ad ? "rgba(74,222,128,.3)" : "rgba(156,163,175,.2)"};padding:3px 10px;border-radius:9999px;">${r.sit || "—"}</span>
            ${r.ad ? `<span style="font-size:10px;font-weight:600;color:rgba(255,255,255,.7);background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);padding:3px 10px;border-radius:9999px;">${r.idx}/5 componentes · ${idxLabel}</span>` : ""}
          </div>
        </div>
        <div style="padding:20px 28px 28px;background:#fff;color:#1d1d1f;">
          ${bodyHtml}
        </div>`;

      const opt = {
        margin: [0, 0, 0, 0],
        filename: `municipio-${slug}-${r.uf ? r.uf.toLowerCase() : "br"}-snc-${new Date().toISOString().slice(0, 10)}.pdf`,
        image: { type: "jpeg", quality: 0.97 },
        html2canvas: { scale: 2, useCORS: true, scrollX: 0, scrollY: 0, backgroundColor: "#ffffff" },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["css", "legacy"] }
      };

      // Remove overflow do modal para html2canvas capturar tudo
      const modalEl = document.querySelector(".modal");
      const prevOverflow = modalEl ? modalEl.style.overflow : "";
      const prevMaxHeight = modalEl ? modalEl.style.maxHeight : "";
      if (modalEl) { modalEl.style.overflow = "visible"; modalEl.style.maxHeight = "none"; }

      setTimeout(() => {
        html2pdf().set(opt).from(container).save().then(() => {
          container.innerHTML = "";
          // Restaura overflow do modal
          if (modalEl) { modalEl.style.overflow = prevOverflow; modalEl.style.maxHeight = prevMaxHeight; }
        });
      }, 150);
    });
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
          <div class="kpi-delta flat">${ultimoAno ? (() => {
            const anoAtual = new Date().getFullYear();
            if (parseInt(ultimoAno.year, 10) === anoAtual) {
              const meses = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
              const mesAtual = meses[new Date().getMonth()];
              return `Jan–${mesAtual}/${anoAtual} · acumulado no ano`;
            }
            return `Ano completo de ${ultimoAno.year}`;
          })() : "Sem dados de período"}</div>
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
          <div class="kpi-delta flat">Entre os concluídos · atributos não exclusivos</div>
        </div>`,
        `<div class="card kpi-card">
          <div class="kpi-top"><div class="kpi-label">Exclusivos de cultura</div><div class="kpi-icon blue">${ICONS.gauge}</div></div>
          <div class="kpi-value">${fmtInt(exclusivos)}</div>
          <div class="kpi-delta flat">Entre os concluídos · um conselho pode ter ambos</div>
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

    // A busca por nome de município não se aplica à tela de Estados.
    const searchControl = document.getElementById("globalMunicipioFilter")
      ? document.getElementById("globalMunicipioFilter").closest(".search-control")
      : null;
    if (searchControl) searchControl.style.display = view === "estados" ? "none" : "";

    // Telas onde o filtro de adesão não faz sentido (componentes, planos, fundo, conselho,
    // estados e adesoes só exibem dados de aderidos por natureza)
    const VIEWS_SEM_ADESAO_FILTER = ["estados", "componentes", "planos", "fundo", "conselho", "adesoes"];
    const adesaoSel = document.getElementById("adesaoFilter");
    if (adesaoSel) adesaoSel.style.display = VIEWS_SEM_ADESAO_FILTER.includes(view) ? "none" : "";

    // Na tela de Componentes, mostrar o dropdown de municípios automaticamente
    // quando um estado já estiver selecionado — facilita o drill-down por município
    if (view === "componentes" && STATE.filters.uf && searchControl) {
      setTimeout(() => {
        const inp = document.getElementById("globalMunicipioFilter");
        if (inp) inp.dispatchEvent(new Event("focus"));
      }, 200);
    }
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
      ? `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M9 9l6 6M15 9l-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none"><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/></svg>`;
    el.innerHTML = `${icon}<span>${escapeHtml(msg)}</span>`;
    el.classList.toggle("toast-error", !!isError);
    el.classList.add("show");
    el.setAttribute("role", "alert");
    el.setAttribute("aria-live", "assertive");
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 5000 : 3400);
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

    // Estados: recalcula agregado próprio ignorando busca por nome de município E filtro de adesão
    // (todos os estados têm adesão — item 1: o filtro de adesão não existe nessa tela)
    const filteredForEstados = STATE.raw.filter((r) => {
      if (STATE.filters.uf && r.uf !== STATE.filters.uf) return false;
      if (STATE.filters.regiao && r.reg !== STATE.filters.regiao) return false;
      if (STATE.filters.periodo && (!r.dtAd || !r.dtAd.startsWith(STATE.filters.periodo))) return false;
      return true;
    });
    STATE.lastAggEstados = S.computeAggregates(filteredForEstados);
    S.renderEstadosTable(STATE.lastAggEstados);

    S.renderMunicipiosTable();
    // Bug #2: Adesões usa aggBase para que o gráfico de evolução nunca seja distorcido pelo filtro de adesão
    S.renderAdesoesView(aggBase);
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
      periodSel.innerHTML = `<option value="">Todos</option>` + anos.map((y) => `<option value="${y}">${y}</option>`).join("");
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

  /* ---------------- Cascata Estado -> Município (painel de Relatórios) — com busca ---------------- */
  function populateRepMunicipioSelect(uf) {
    const inp = document.getElementById("repMunicipioInput");
    const dd = document.getElementById("repMunicipioDropdown");
    const hiddenSel = document.getElementById("repMunicipio");
    if (!inp || !dd || !hiddenSel) return;

    if (!uf) {
      inp.value = "";
      inp.placeholder = "Selecione o estado primeiro";
      inp.disabled = true;
      dd.style.display = "none";
      hiddenSel.value = "";
      return;
    }

    const tipoEl = document.getElementById("repTipo");
    const isContatos = tipoEl && tipoEl.value === "contatos";
    inp.disabled = false;
    inp.value = "";
    hiddenSel.value = "";
    inp.placeholder = isContatos ? "Todos (ou filtre por município)" : "Digite o nome do município...";

    const municipios = STATE.raw.filter((r) => r.uf === uf).slice().sort((a, b) => a.m.localeCompare(b.m));

    function renderDropdown(filter) {
      const q = (filter || "").toLowerCase().trim();
      const filtered = q ? municipios.filter((r) => r.m.toLowerCase().includes(q)) : municipios;
      if (!filtered.length) {
        dd.innerHTML = `<div style="padding:10px 14px;color:var(--muted);font-size:13px;">Nenhum município encontrado</div>`;
      } else {
        dd.innerHTML = (isContatos ? `<div class="rep-muni-opt" data-value="" style="padding:10px 14px;cursor:pointer;font-size:13px;font-style:italic;border-bottom:1px solid var(--border);">Todos os municípios do estado</div>` : "") +
          filtered.map((r) => `<div class="rep-muni-opt" data-value="${escapeHtml(r.m)}" style="padding:9px 14px;cursor:pointer;font-size:13px;${!r.ad ? "color:var(--muted);" : ""}">${escapeHtml(r.m)}${!r.ad ? " <small>(sem adesão)</small>" : ""}</div>`).join("");
        dd.querySelectorAll(".rep-muni-opt").forEach((el) => {
          el.addEventListener("mousedown", (e) => {
            e.preventDefault();
            const val = el.getAttribute("data-value");
            inp.value = val || "";
            hiddenSel.value = val || "";
            hiddenSel.innerHTML = `<option value="${escapeHtml(val || "")}" selected>${escapeHtml(val || "")}</option>`;
            dd.style.display = "none";
          });
          el.addEventListener("mouseenter", () => { el.style.background = "var(--surface-2)"; });
          el.addEventListener("mouseleave", () => { el.style.background = ""; });
        });
      }
    }

    inp.addEventListener("focus", () => { renderDropdown(inp.value); dd.style.display = "block"; });
    inp.addEventListener("input", () => { renderDropdown(inp.value); dd.style.display = "block"; hiddenSel.value = ""; });
    inp.addEventListener("blur", () => { setTimeout(() => { dd.style.display = "none"; }, 150); });

    // Fechar ao clicar fora
    document.addEventListener("click", (e) => {
      if (!inp.contains(e.target) && !dd.contains(e.target)) dd.style.display = "none";
    }, { once: false });
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
        // Calcula a data mais recente da planilha para exibir no toast de confirmação
        const datasUpd = normalized.filter((r) => r.upd).map((r) => r.upd);
        const dataRef = datasUpd.length
          ? fmtDate(datasUpd.reduce((max, d) => (d > max ? d : max)))
          : "data não identificada";
        showToast(`Planilha carregada: ${fmtInt(normalized.length)} municípios · dados até ${dataRef}.`);
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
        // Bug #3: ao selecionar estado, limpar região (mutuamente exclusivos)
        if (ufFilter.value && STATE.filters.regiao) {
          STATE.filters.regiao = "";
          const regiaoSel = document.getElementById("regiaoFilter");
          if (regiaoSel) regiaoSel.value = "";
        }
        refreshAll();
        // Item 3: na tela de Estados, ao escolher um estado no filtro, abre o modal completo
        if (STATE.currentView === "estados" && ufFilter.value && S.openEstadoModal) {
          setTimeout(() => {
            S.openEstadoModal(ufFilter.value, STATE.lastAggEstados || STATE.lastAgg);
          }, 150);
        }
      });
    }

    const periodFilter = document.getElementById("periodFilter");
    if (periodFilter) periodFilter.addEventListener("change", () => { STATE.filters.periodo = periodFilter.value; refreshAll(); });

    const regiaoFilter = document.getElementById("regiaoFilter");
    if (regiaoFilter) regiaoFilter.addEventListener("change", () => {
      // Bug #3: ao selecionar região, limpar estado (combinação gera 0 resultados)
      if (regiaoFilter.value && STATE.filters.uf) {
        STATE.filters.uf = "";
        const ufSel = document.getElementById("ufFilter");
        if (ufSel) ufSel.value = "";
      }
      STATE.filters.regiao = regiaoFilter.value;
      refreshAll();
    });

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
      // Bug #6: quando só a busca de município está ativa, adicionar nota que KPIs não mudam
      const kpiNote = document.getElementById("kpiSearchNote");
      if (kpiNote) kpiNote.style.display = (f.search && !f.uf && !f.regiao && !f.periodo) ? "" : "none";
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
          // Item 2: mostrar barra de ações
          const actionsBar = document.getElementById("reportActionsBar");
          if (actionsBar && container && container.innerHTML.trim()) actionsBar.style.display = "flex";
        }, 30);
      });
    }
    updateRepFormVisibility();

    // Item 2: botões de imprimir e exportar PDF do relatório detalhado
    const btnImprimirRel = document.getElementById("btnImprimirRelatorio");
    if (btnImprimirRel) {
      btnImprimirRel.addEventListener("click", () => {
        document.body.classList.add("printing-report");
        const cleanup = () => document.body.classList.remove("printing-report");
        window.addEventListener("afterprint", cleanup, { once: true });
        window.print();
        setTimeout(cleanup, 2000);
      });
    }
    const btnExportarRelDet = document.getElementById("btnExportarRelatorioDetalhado");
    if (btnExportarRelDet) {
      btnExportarRelDet.addEventListener("click", () => {
        if (typeof html2pdf === "undefined") { showToast("Biblioteca PDF não carregou.", true); return; }
        const container = document.getElementById("reportContainer");
        if (!container || !container.innerHTML.trim()) { showToast("Gere um relatório primeiro.", true); return; }
        const tipo = STATE.activeReportKind || "relatorio";
        const uf = (document.getElementById("repEstado") || {}).value || "br";
        const dataStr = new Date().toISOString().slice(0, 10);
        const isLandscape = tipo === "checklist" || tipo === "contatos";
        const opt = {
          margin: [8, 8, 8, 8],
          filename: `${tipo}-snc-${uf.toLowerCase()}-${dataStr}.pdf`,
          image: { type: "jpeg", quality: 0.97 },
          html2canvas: { scale: 2, useCORS: true, scrollX: 0, scrollY: 0 },
          jsPDF: { unit: "mm", format: "a4", orientation: isLandscape ? "landscape" : "portrait" },
          pagebreak: { mode: ["css", "legacy"] }
        };
        const contentEl = document.getElementById("content");
        if (contentEl) contentEl.scrollTop = 0;
        window.scrollTo(0, 0);
        html2pdf().set(opt).from(container.querySelector(".report-page") || container).save();
      });
    }

    const btnIrRelatorios = document.getElementById("btnIrParaRelatorios");
    if (btnIrRelatorios) btnIrRelatorios.addEventListener("click", () => goTo("relatorios"));

    const btnExcel = document.getElementById("btnExportExcel");
    if (btnExcel) btnExcel.addEventListener("click", () => {
      showToast("Gerando planilha Excel, aguarde...");
      setTimeout(() => S.exportExcel(), 80);
    });

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

    // Expor para uso cross-IIFE (ex: modal do estado navegar para Relatórios)
    S.updateRepFormVisibility = updateRepFormVisibility;
    window.__SNC.updateRepFormVisibility = updateRepFormVisibility;
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

  /* helpers visuais para o checklist */
  const CIRCLE_OK = `<span style="color:#16a34a;font-size:15px;line-height:1;" title="Concluído">●</span>`;
  const CIRCLE_NO = `<svg viewBox="0 0 16 16" fill="none" width="15" height="15" style="vertical-align:middle;" title="Pendente"><path d="M3 3l10 10M13 3L3 13" stroke="#dc2626" stroke-width="2.2" stroke-linecap="round"/></svg>`;

  function checklistCell(done) {
    return `<td style="text-align:center;">${done ? CIRCLE_OK : CIRCLE_NO}</td>`;
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
            <th>Atualização</th><th style="text-align:center;">Sistema</th><th style="text-align:center;">Conselho</th><th style="text-align:center;">Ata</th><th style="text-align:center;">Fundo</th><th style="text-align:center;">Plano</th><th style="text-align:center;">Órgão Gestor</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td><b>${escapeHtml(r.m)}</b></td>
              ${showAdesao ? `<td>${r.ad ? `<span class="status-badge green">✓ Aderido</span>` : `<span class="status-badge gray">Sem adesão</span>`}</td>` : ""}
              <td>${r.upd ? fmtDate(r.upd) : "—"}</td>
              ${checklistCell(r.sisSt === "Concluída")}
              ${checklistCell(r.conSt === "Concluída")}
              ${checklistCell(r.ataSt === "Concluída")}
              ${checklistCell(r.funSt === "Concluída")}
              ${checklistCell(r.plaSt === "Concluída")}
              ${checklistCell(r.orgSt === "Concluída")}
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

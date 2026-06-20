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
    filters: { uf: "", periodo: "", search: "" },
    table: { sortKey: "idx", sortDir: "desc", page: 1, pageSize: 25, search: "" },
    mapLabels: true,
    charts: {}
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
        sit: aderiu ? (sitStr || "Publicado no DOU") : "Nao possui adesão",
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
    const piorEstado = Object.values(byUF).filter((b) => b.total >= 3).sort((a, b) => a.pct - b.pct)[0];

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

  function renderKPIs(agg, containerId) {
    const el = document.getElementById(containerId || "kpiRow");
    if (!el) return;
    el.innerHTML = [
      kpiCardHtml({
        label: "Total de Municípios", value: fmtInt(agg.total), tone: "blue", icon: ICONS.municipios,
        delta: `${fmtInt(Object.keys(agg.byUF).length)} unidades federativas`, deltaTone: "flat"
      }),
      kpiCardHtml({
        label: "Municípios com Adesão", value: fmtInt(agg.aderidosCount), tone: "green", icon: ICONS.check,
        delta: `${fmtPct(agg.pctAderidos)} do total nacional`, deltaTone: "up"
      }),
      kpiCardHtml({
        label: "Municípios sem Adesão", value: fmtInt(agg.naoAderidos), tone: "red", icon: ICONS.x,
        delta: `${fmtPct(100 - agg.pctAderidos)} do total nacional`, deltaTone: "down"
      }),
      kpiCardHtml({
        label: "Índice Nacional de Implementação", value: fmtPct(agg.indiceNacional), tone: "amber", icon: ICONS.gauge,
        delta: `Média dos 5 componentes do SNC`, deltaTone: "flat"
      })
    ].join("");
  }

  /* ---------------- Gráfico: evolução das adesões ---------------- */
  function renderEvolucaoChart(agg, canvasId) {
    mkChart(canvasId || "chartEvolucao", {
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
    });
  }

  /* ---------------- Gráfico: adesões por estado (ranking, barras horizontais) ---------------- */
  function renderEstadosChart(agg, canvasId) {
    const arr = Object.values(agg.byUF).sort((a, b) => b.aderidos - a.aderidos).slice(0, 12);
    mkChart(canvasId || "chartEstados", {
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
    });
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
      html += `<g class="map-tile" data-uf="${uf}">
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

  S.renderKPIs = renderKPIs;
  S.renderEvolucaoChart = renderEvolucaoChart;
  S.renderEstadosChart = renderEstadosChart;
  S.renderComponentesChart = renderComponentesChart;
  S.renderDonut = renderDonut;
  S.renderGauge = renderGauge;
  S.renderBrazilMap = renderBrazilMap;
  S.mkChart = mkChart;
  S.ICONS = ICONS;
})();

/* ============================================================================
   PARTE 3 — Alertas, Tabela de Estados, Tabela de Municípios e Modal
   ============================================================================ */
(function () {
  "use strict";
  const S = window.__SNC;
  const { STATE, UF_NOME, COMPONENT_KEYS, COMPONENT_LABELS, classifyMaturity,
    fmtInt, fmtPct, fmtDate, escapeHtml } = S;
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
  const ESTADOS_COLUMNS = [
    { key: "uf", label: "UF" }, { key: "nome", label: "Estado" },
    { key: "total", label: "Municípios" }, { key: "aderidos", label: "Aderidos" },
    { key: "pct", label: "% Adesão" }, { key: "idxMedio", label: "Índice médio" },
    { key: "sisPct", label: "Sistema" }, { key: "conPct", label: "Conselho" },
    { key: "funPct", label: "Fundo" }, { key: "plaPct", label: "Plano" }, { key: "orgPct", label: "Órgão Gestor" }
  ];

  function renderEstadosTable(agg) {
    const table = document.getElementById("tableEstados");
    if (!table) return;
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

    rows.sort((a, b) => {
      const va = a[sort.key], vb = b[sort.key];
      if (typeof va === "string") return sort.dir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      return sort.dir === "asc" ? va - vb : vb - va;
    });

    const thead = table.querySelector("thead");
    thead.innerHTML = `<tr>${ESTADOS_COLUMNS.map((c) => {
      const active = sort.key === c.key;
      return `<th class="${active ? "sorted" : ""}" data-key="${c.key}" style="cursor:pointer;">${c.label}<span class="sort-arrow">${active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}</span></th>`;
    }).join("")}</tr>`;
    thead.querySelectorAll("th[data-key]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.getAttribute("data-key");
        if (sort.key === key) sort.dir = sort.dir === "asc" ? "desc" : "asc";
        else { sort.key = key; sort.dir = "desc"; }
        renderEstadosTable(STATE.lastAgg);
      });
    });

    const tbody = table.querySelector("tbody");
    tbody.innerHTML = rows.map((r) => `
      <tr data-uf="${r.uf}" style="cursor:pointer;">
        <td><b>${r.uf}</b></td>
        <td>${r.nome}</td>
        <td>${fmtInt(r.total)}</td>
        <td>${fmtInt(r.aderidos)}</td>
        <td>${fmtPct(r.pct)}</td>
        <td>${r.idxMedio.toFixed(1)} / 5</td>
        <td>${fmtPct(r.sisPct, 0)}</td>
        <td>${fmtPct(r.conPct, 0)}</td>
        <td>${fmtPct(r.funPct, 0)}</td>
        <td>${fmtPct(r.plaPct, 0)}</td>
        <td>${fmtPct(r.orgPct, 0)}</td>
      </tr>`).join("");
    tbody.querySelectorAll("tr[data-uf]").forEach((tr) => {
      tr.addEventListener("click", () => window.__SNC.goToUF(tr.getAttribute("data-uf")));
    });
  }

  S.renderAlerts = renderAlerts;
  S.renderEstadosTable = renderEstadosTable;
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
    { key: "__comp", label: "Componentes", sortable: false },
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
    if (prev) prev.addEventListener("click", () => { if (STATE.table.page > 1) { STATE.table.page--; renderMunicipiosTable(); } });
    if (next) next.addEventListener("click", () => { STATE.table.page++; renderMunicipiosTable(); });
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
      if (c.sortable === false) return `<th>${c.label}</th>`;
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
          <td><div class="idx-dot-row">${COMPONENT_KEYS.map((k) => `<span class="idx-dot ${r[k] ? "on" : ""}" title="${COMPONENT_LABELS[k]}"></span>`).join("")}</div></td>
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
      <div class="detail-item"><label>${COMPONENT_LABELS[k]}</label><div style="color:${r[k] ? "var(--success)" : "var(--danger)"}">${r[k] ? "Concluído" : "Pendente"}</div></div>`).join("");
    content.innerHTML = `
      <div class="modal-header">
        <div>
          <h2>${escapeHtml(r.m)} <span class="pill gray" style="margin-left:6px;">${r.uf}</span></h2>
          <span>${UF_NOME[r.uf] || r.uf} · ${r.reg || "—"}${r.ibge ? " · IBGE " + r.ibge : ""}</span>
        </div>
        <button class="modal-close" id="modalCloseBtn"><svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
      </div>
      <div class="detail-grid">
        <div class="detail-item"><label>Situação da adesão</label><div>${escapeHtml(r.sit)}</div></div>
        <div class="detail-item"><label>Data de adesão</label><div>${fmtDate(r.dtAd)}</div></div>
        <div class="detail-item"><label>Índice de maturidade</label><div>${r.idx} / 5 — ${classifyMaturity(r.idx).label}</div></div>
        <div class="detail-item"><label>Última atualização</label><div>${fmtDate(r.upd)}</div></div>
        ${compItems}
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
  }
  function closeModal() {
    const backdrop = document.getElementById("modalBackdrop");
    if (backdrop) backdrop.classList.remove("open");
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

  /* ---------------- Brasil: cards por região + segundo mapa ---------------- */
  const REGIAO_ORDEM = ["Norte", "Nordeste", "Centro Oeste", "Sudeste", "Sul"];

  function renderBrasilView(agg) {
    const el = document.getElementById("regiaoCards");
    if (el) {
      const cards = REGIAO_ORDEM.map((reg) => {
        const b = agg.byRegiao[reg] || { total: 0, aderidos: 0, pct: 0 };
        return `
          <div class="card kpi-card">
            <div class="kpi-top">
              <div class="kpi-label">${reg}</div>
              <div class="kpi-icon blue">${ICONS.municipios}</div>
            </div>
            <div class="kpi-value">${fmtPct(b.pct)}</div>
            <div class="kpi-delta flat">${fmtInt(b.aderidos)} de ${fmtInt(b.total)} municípios aderidos</div>
          </div>`;
      }).join("");
      el.innerHTML = cards;
    }
    S.renderBrazilMap("brazilMap2", "mapStatePanel2", agg);
  }

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

  S.renderBrasilView = renderBrasilView;
  S.renderAdesoesView = renderAdesoesView;
  S.renderComponentesView = renderComponentesView;
  S.renderPlanosView = renderPlanosView;
})();

/* ============================================================================
   PARTE 6 — Relatório Executivo e Exportações (PDF / Excel)
   ============================================================================ */
(function () {
  "use strict";
  const S = window.__SNC;
  const { STATE, UF_NOME, COMPONENT_KEYS, COMPONENT_LABELS,
    fmtInt, fmtPct, fmtDate, escapeHtml } = S;

  function chartImg(canvasId, alt) {
    const chart = STATE.charts[canvasId];
    if (!chart) return "";
    try {
      const src = chart.toBase64Image();
      return `<img src="${src}" alt="${alt}" style="width:100%;max-width:520px;display:block;margin:0 auto;">`;
    } catch (e) { return ""; }
  }

  function renderReport(agg) {
    const el = document.getElementById("reportContainer");
    if (!el || !agg) return;

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
          ${chartImg("chartEvolucao", "Evolução das adesões")}
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
      renderReport(STATE.lastAgg);
    }
    window.__SNC.goTo("relatorios");
    const target = document.querySelector("#reportContainer .report-page");
    if (!target) return;
    const dataStr = new Date().toISOString().slice(0, 10);
    const opt = {
      margin: [10, 10, 10, 10],
      filename: `relatorio-executivo-snc-${dataStr}.pdf`,
      image: { type: "jpeg", quality: 0.97 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["css", "legacy"] }
    };
    html2pdf().set(opt).from(target).save();
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
  const { STATE, UF_NOME, fmtInt, fmtPct, debounce, escapeHtml } = S;

  const VIEW_META = {
    dashboard: { title: "Dashboard Executivo", sub: "Monitoramento nacional do Sistema Nacional de Cultura" },
    brasil: { title: "Brasil", sub: "Visão geográfica da adesão por unidade federativa" },
    estados: { title: "Estados", sub: "Painel comparativo por unidade federativa" },
    municipios: { title: "Municípios", sub: "Tabela executiva com busca, ordenação e detalhamento" },
    adesoes: { title: "Adesões", sub: "Evolução histórica e situação das adesões ao SNC" },
    componentes: { title: "Componentes", sub: "Sistema, Conselho, Fundo, Plano e Órgão Gestor" },
    planos: { title: "Planos de Cultura", sub: "Monitoramento e vigência dos planos municipais" },
    relatorios: { title: "Relatórios", sub: "Relatório executivo consolidado, pronto para exportação" },
    exportacoes: { title: "Exportações", sub: "Exportação de dados e atualização da base" },
    config: { title: "Configurações", sub: "Preferências de exibição e fonte de dados" }
  };

  /* ---------------- Navegação ---------------- */
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

    S.renderKPIs(agg, "kpiRow");
    S.renderEvolucaoChart(agg, "chartEvolucao");
    S.renderEstadosChart(agg, "chartEstados");
    S.renderComponentesChart(agg, "chartComponentes");
    S.renderDonut(agg, "chartDonut", "donutLegend");
    S.renderGauge(agg);
    S.renderBrazilMap("brazilMap", "mapStatePanel", agg);
    S.renderAlerts(agg);
    S.renderEstadosTable(agg);
    S.renderMunicipiosTable();
    S.renderAdesoesView(agg);
    S.renderComponentesView(agg);
    S.renderPlanosView(agg);
    S.renderBrasilView(agg);

    const cfgFonte = document.getElementById("cfgFonte");
    const cfgTotal = document.getElementById("cfgTotal");
    if (cfgFonte) cfgFonte.textContent = STATE.sourceLabel;
    if (cfgTotal) cfgTotal.textContent = fmtInt(STATE.raw.length) + " municípios carregados";
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
      periodSel.innerHTML = `<option value="">Todo o período</option>` + anos.map((y) => `<option value="${y}">${y}</option>`).join("");
    }
    const pageSizeSel = document.getElementById("cfgPageSize");
    if (pageSizeSel) pageSizeSel.value = String(STATE.table.pageSize);
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
        STATE.filters = { uf: "", periodo: "", search: "" };
        document.getElementById("globalMunicipioFilter").value = "";
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
      item.addEventListener("click", () => goTo(item.getAttribute("data-view")));
    });

    const ufFilter = document.getElementById("ufFilter");
    if (ufFilter) ufFilter.addEventListener("change", () => { STATE.filters.uf = ufFilter.value; refreshAll(); });

    const periodFilter = document.getElementById("periodFilter");
    if (periodFilter) periodFilter.addEventListener("change", () => { STATE.filters.periodo = periodFilter.value; refreshAll(); });

    const globalSearch = document.getElementById("globalMunicipioFilter");
    if (globalSearch) {
      globalSearch.addEventListener("input", debounce(() => {
        STATE.filters.search = globalSearch.value.trim();
        refreshAll();
      }, 320));
    }

    const tableSearch = document.getElementById("tableSearch");
    if (tableSearch) {
      tableSearch.addEventListener("input", debounce(() => {
        STATE.table.search = tableSearch.value.trim();
        STATE.table.page = 1;
        S.renderMunicipiosTable();
      }, 280));
    }

    const btnRefresh = document.getElementById("btnRefresh");
    if (btnRefresh) btnRefresh.addEventListener("click", () => { refreshAll(); showToast("Dados atualizados."); });

    const fileUpload = document.getElementById("fileUpload");
    if (fileUpload) fileUpload.addEventListener("change", (e) => { handleFileUpload(e.target.files[0]); e.target.value = ""; });
    const fileUpload2 = document.getElementById("fileUpload2");
    if (fileUpload2) fileUpload2.addEventListener("change", (e) => { handleFileUpload(e.target.files[0]); e.target.value = ""; });

    const btnGerar = document.getElementById("btnGerarRelatorio");
    if (btnGerar) btnGerar.addEventListener("click", () => { S.renderReport(STATE.lastAgg); goTo("relatorios"); });

    const btnPdf = document.getElementById("btnExportPdf");
    if (btnPdf) btnPdf.addEventListener("click", () => S.exportPdfReport());
    const btnPdf2 = document.getElementById("btnExportPdf2");
    if (btnPdf2) btnPdf2.addEventListener("click", () => S.exportPdfReport());

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
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") S.closeModal(); });
  }

  /* ---------------- Inicialização ---------------- */
  document.addEventListener("DOMContentLoaded", () => {
    STATE.raw = (typeof SNC_DEFAULT_DATA !== "undefined") ? SNC_DEFAULT_DATA : [];
    if (typeof SNC_DATA_META !== "undefined" && SNC_DATA_META.total) {
      STATE.sourceLabel = `Base oficial SNC (carregada automaticamente · ${fmtInt(SNC_DATA_META.total)} municípios)`;
    }
    populateFilters();
    wireEvents();
    refreshAll();
    goTo("dashboard");
  });

  S.goTo = goTo;
  S.goToUF = goToUF;
  S.refreshAll = refreshAll;
  S.showToast = showToast;
})();

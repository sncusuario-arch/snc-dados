# SNC Dashboard — Contexto do Projeto

## O que é este projeto
Dashboard de monitoramento nacional do Sistema Nacional de Cultura (SNC), coordenado pela
Divisão do Sistema Nacional de Cultura (DSNC) — Secretaria de Articulação Federativa e Comitês
de Cultura (SAFCC) — Ministério da Cultura. Site estático publicado no GitHub Pages:
`https://sncusuario-arch.github.io/snc-dados/`
Responsável: Fagner Silva Ribeiro, Chefe de Divisão DSNC.

## Arquivos do repositório
| Arquivo | Função |
|---|---|
| `index.html` | Estrutura HTML de todas as telas (Dashboard, Estados, Municípios, Adesões, Componentes, Planos, Fundo, Conselho, Relatórios, Exportações, Configurações) |
| `app.js` | Toda a lógica: filtros, gráficos (Chart.js), tabelas, relatórios PDF, persistência local |
| `style.css` | Design system Apple (ver seção abaixo) |
| `data.js` | Dados gerados automaticamente pelo `extract.py` — **nunca editar manualmente** |
| `extract.py` | Lê a planilha oficial `.xls` do SNC e gera o `data.js` |
| `chart.umd.js`, `xlsx.full.min.js`, `html2pdf.bundle.min.js` | Bibliotecas de terceiros vendorizadas — não modificar |

## Fluxo de atualização de dados (IMPORTANTE)
1. Fagner baixa a planilha oficial atualizada do portal do SNC (`.xls`)
2. Roda `python3 extract.py` (lê a planilha, gera `data.js` novo)
3. Sobe o `data.js` no GitHub
4. Todos os usuários do link veem os dados atualizados automaticamente — a classificação
   (Plena/Provisória, componentes, etc.) é **recalculada dinamicamente no navegador** a partir
   dos campos brutos (`sis`, `con`, `pla`, `fun`, `ad`) — não precisa mexer no `app.js` para isso.

## Design system (obrigatório em qualquer novo elemento visual)
Estilo Apple. Sempre usar estas variáveis/cores, nunca hardcodar outras:
```
--bg: #f5f5f7        --accent: #007aff       --success: #1d8348
--surface: #ffffff   --accent-light: #e8f1ff --danger: #c0392b
--surface-2: #f5f5f7 --text: #1d1d1f         --warning: #d4a017
--muted: #6e6e73      --border: #d2d2d7
--radius-card: 14px   --shadow-md: 0 2px 8px rgba(0,0,0,0.06)
```
Fonte: Inter (Google Fonts). Botões pill (`border-radius: 9999px`). Zero emojis — só SVG inline.
Espaço em branco generoso. Regra vale para relatórios, PDFs, dashboards — qualquer output visual.

## Classificação legal Adesão Plena / Provisória (Lei 14.835/2024, art. 5º §§4º-5º)
Regra validada e fixa — **não alterar sem confirmação explícita do Fagner**:
- **Adesão Plena** = `sis===1 && con===1 && pla===1 && fun===1` (Lei do Sistema + Conselho + Plano + Fundo)
- **Adesão Provisória** = `sis!==1 && con===1 && pla===1 && fun===1` (Conselho + Plano + Fundo, SEM Lei do Sistema)
Implementado em duas funções no `app.js`: `isAdesaoPlena(r)` e `isAdesaoProvisoria(r)`, e
duplicado dentro de `computeAggregates()`. **Se alterar a regra, alterar nos dois lugares.**
Validado contra dados reais em 2026-07-07: 748 Plena / 67 Provisória (sobre 3.931 aderidos).

## Estrutura de dados de cada município (campo em `data.js`)
```
m       — nome do município          uf      — sigla do estado
reg     — região                     ibge    — código IBGE
pop     — população                  porte   — faixa de porte (só preenchido se aderiu)
sit     — situação (Publicado no DOU / Aguardando publicação no DOU / Diligência Documental / Sem adesão)
ad      — boolean, tem adesão        dtAd    — data da adesão (YYYY-MM-DD)
sis/con/fun/pla/org — 1 ou 0 por componente (Sistema/Conselho/Fundo/Plano/Órgão Gestor)
idx     — índice de maturidade (0-5, soma dos componentes)
sisSt/conSt/funSt/plaSt/orgSt — status textual de cada componente
sisData/conData/funData/planoData/orgData — data de conclusão de cada componente
venc    — 1 se plano de cultura vencido      mon — 1 se plano monitorado
vig     — ano de vigência do plano
conParit/conExcl — booleans (conselho paritário / exclusivo de cultura)
upd     — data da última atualização do registro na planilha
pref/gestor/cad — nomes de prefeito/gestor/cadastrador
emailPref/emailGestor/emailCad — e-mails de contato
```

## Lições aprendidas (bugs já resolvidos — não repetir)
1. **`refreshAll()` sem qualificador dentro de IIFEs que não a definem localmente causa
   `ReferenceError` silencioso** dentro de event listeners — a UI parece "não fazer nada" ao
   clicar, mas na verdade um erro está sendo engolido. Sempre chamar como
   **`window.__SNC.refreshAll()`** quando o código estiver em uma `Parte` do arquivo diferente
   de onde `refreshAll` é definido (Parte de wireEvents). Mesma lógica vale para outras
   funções expostas via `window.__SNC` — quando em dúvida, usar o prefixo qualificado.
2. **Upload de arquivo pelo GitHub via "Add file" cria duplicata ou commit vazio** ("0 file
   changed") — sempre editar pelo **lápis** (Edit this file) e fazer commit direto, nunca usar
   upload para substituir arquivo existente.
3. **`node --check` só valida sintaxe, não comportamento em runtime.** Antes de considerar uma
   correção pronta — especialmente em cliques/handlers — simular com `jsdom` carregando o
   `app.js` real e disparando o evento de clique de verdade, checando o resultado no DOM.
   Isso já pegou bugs reais que a leitura de código não detectou.
4. **Gráficos Chart.js precisam de `showLabels: true` no dataset** para mostrar números sem
   hover, usando o plugin customizado `SNC_DATALABELS_PLUGIN` (já registrado globalmente). Para
   donuts/pie, o plugin desenha labels externos com linha de conexão, ignorando fatias < 3%.
   Ao criar um gráfico novo, sempre adicionar `showLabels: true` e `labelFormatter` no dataset.
5. **Alterações devem ser cirúrgicas** — usar `str_replace` com contexto único, nunca reescrever
   trechos maiores do que o pedido. Regressões já aconteceram por partir de versões desatualizadas
   do arquivo; sempre trabalhar a partir do arquivo real mais recente enviado pelo usuário, não de
   memória de sessões anteriores.
6. **Persistência local:** planilhas carregadas pelo botão "Carregar planilha" são salvas no
   IndexedDB do navegador (`snc-dashboard` / store `planilha`) para sobreviver ao F5. Um banner no
   topo mostra a origem dos dados ativos (planilha local vs. base oficial). Isso é por navegador —
   não sincroniza entre usuários. Para atualizar a base oficial para todos, o único caminho é
   `extract.py` → `data.js` → commit no GitHub.

## Convenções de commit
- Mensagens diretas em português, descrevendo o que mudou (ex: `Corrige labels do gráfico de Fundo`)
- Nunca commitar diretamente sem mostrar o diff para o Fagner revisar antes
- Nunca usar `git push --force`
- Perguntar antes de dar push, mesmo que a mudança pareça pequena

## Estilo de comunicação com o Fagner
- Direto, sem preâmbulo excessivo
- Antes de mudanças grandes ou ambíguas, perguntar antes de executar
- Fagner autoriza execução com "pode executar", "executa", "pronto configurado" etc.
- Ele testa no navegador (não é desenvolvedor) — sempre dar o passo a passo claro de onde clicar

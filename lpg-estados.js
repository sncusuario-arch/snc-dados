// lpg-estados.js
// Total recebido por estado (UF) na Lei Paulo Gustavo (Lei nº 14.399/2022).
// Fonte: painel de pagamento oficial (PDF "PauloGustavoPaineldePagamento_DetalheEstados").
// Chave = sigla da UF (mesmo campo "uf" usado em data.js / SNC_ESTADOS_DATA).
//
// Gerado manualmente a partir do PDF — não é regenerado pelo extract.py. Para atualizar,
// seria necessário reprocessar um painel de pagamento novo.
//
const SNC_LPG_ESTADOS = {"SP":357575060.5,"MG":182397750.5,"BA":147863976.8,"RJ":138991498.9,"PE":100158734.2,"PR":98499446.7,"CE":95447562.86,"PA":91735347.63,"RS":91491111.38,"MA":81466999.57,"GO":68579249.9,"SC":60192685.29,"AM":51714200.41,"PB":48677436.9,"AL":43943300.33,"PI":42268211.53,"ES":40760549.57,"RN":39783840.08,"MT":36006534.91,"SE":32759672.12,"RO":27563051.32,"MS":27199344.33,"DF":26049643.67,"TO":25681441.21,"AP":22697846.23,"AC":22463131.19,"RR":19401177.57};

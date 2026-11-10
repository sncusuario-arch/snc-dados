import pandas as pd
import json
import os
import re
import sys
import datetime

# Aceita os dois formatos de planilha do portal SNC:
#  - novo (2026-11): ente_federado.xlsx, aba "Worksheet", vocabulário sem acento
#    ("Concluido", "Publicado dou", "Em analise", "Diligencia documental"...)
#  - antigo: dados-municipios-cadastrados-snc.xls, aba "SNC"
# Uso: python3 extract.py [caminho_da_planilha]
ARQUIVO = sys.argv[1] if len(sys.argv) > 1 else 'ente_federado.xlsx'
_abas = pd.ExcelFile(ARQUIVO).sheet_names
df = pd.read_excel(ARQUIVO, sheet_name='SNC' if 'SNC' in _abas else _abas[0])

ESTADO_RE = r'(?i)^Estado (de|do|da|dos|das) '  # (?i): a planilha nova traz "ESTADO DA BAHIA" em maiúsculas

def col(r, *nomes):
    """Valor da primeira coluna existente entre os nomes (formato novo primeiro, depois o antigo)."""
    for n in nomes:
        if n in r.index:
            return r[n]
    return None

# Situação do ente — formato novo traduzido para o vocabulário usado no dashboard
SIT_MAP = {
    'Publicado dou': 'Publicado no DOU',
    'Em analise': 'Aguardando publicação no DOU',
    'Diligencia documental': 'Diligência Documental',
    'Aguardando preenchimento': 'Não possui adesão',
    'Nao possui adesão': 'Não possui adesão',
}

def norm_sit(v):
    v = v.strip() if isinstance(v, str) else 'Não possui adesão'
    return SIT_MAP.get(v, v)

# Status dos componentes — formato novo traduzido para o vocabulário usado no dashboard
STATUS_MAP = {
    'Concluido': 'Concluída',
    'Concluído': 'Concluída',
    'Aprovado': 'Concluída',          # ata do conselho
    'Aguardando preenchimento': 'Não informado(a)',
    'Apto analise': 'Apto para análise',
    'Aguardando analise': 'Aguardando análise',
    'Em diligencia': 'Em diligência',
    'Nao instituido': 'Não instituído',
}

def norm_status(v):
    if not isinstance(v, str):
        return None
    v = v.strip()
    return STATUS_MAP.get(v, v)

def fmt_cnpj(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    s = re.sub(r'\D', '', str(v).split('.')[0] if isinstance(v, float) else str(v))
    if not s:
        return None
    s = s.zfill(14)
    return f"{s[:2]}.{s[2:5]}.{s[5:8]}/{s[8:12]}-{s[12:]}" if len(s) == 14 else s

# A planilha nova traz alguns nomes sem acento e com prefixo ("MUNICIPIO DE JOAO PESSOA") e
# apóstrofo dobrado ("Alta Floresta D''Oeste"). nomes_municipios.json (código IBGE -> nome
# oficial) fica no repositório para restaurar o nome correto nesses casos.
try:
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'nomes_municipios.json'), encoding='utf-8') as _f:
        NOMES_REF = json.load(_f)
except FileNotFoundError:
    NOMES_REF = {}

def nome_municipio(nome, ibge):
    n = str(nome).strip().replace("''", "'")
    if re.match(r'(?i)^munic[ií]pio de ', n) or n.isupper():
        ref = NOMES_REF.get(str(int(ibge))) if pd.notna(ibge) else None
        if ref:
            return ref
        n = re.sub(r'(?i)^munic[ií]pio de ', '', n)
        n = ' '.join(p.lower() if p.lower() in ('de', 'do', 'da', 'dos', 'das', 'e') else p.capitalize() for p in n.split())
    return n

mun = df[~df['Ente Federado'].str.match(ESTADO_RE, na=False)].copy()
# Remove duplicidade do Distrito Federal: a planilha traz "Distrito Federal" (ibge=53, com
# adesão publicada) e também "Brasília" (ibge=5300108, "Nao possui adesão") como o mesmo ente.
# Mantém apenas "Distrito Federal" (situação real e correta) para não contar o DF duas vezes.
mun = mun[~((mun['UF'] == 'DF') & (mun['Ente Federado'] == 'Brasília'))].copy()

def is_done(v):
    return 1 if norm_status(v) == 'Concluída' else 0

def parse_date(v):
    if not isinstance(v, str):
        return None
    m = re.match(r'(\d{2})/(\d{2})/(\d{4})', v)
    if m:
        d, mo, y = m.groups()
        return f"{y}-{mo}-{d}"
    return None

def clean_status(v):
    """Retorna o status granular bruto da planilha, ou None se não houver dado de fato."""
    return norm_status(v)

SENTINEL_VALUES = {'Não informado(a)', 'Nao possui adesão', 'Não possui adesão', 'Aguardando preenchimento', 'Não informado'}

def clean_text(v):
    if isinstance(v, str) and v.strip() and v.strip() not in SENTINEL_VALUES:
        return v.strip()
    return None

def yn(v):
    if v == 'Sim':
        return True
    if v == 'Não':
        return False
    return None

def porte_curto(v):
    # "Porte 1 (Pequeno I): até 20.000" -> "Porte 1 (Pequeno I)" (vale para o texto antigo e o novo)
    m = re.match(r'(Porte \d \([^)]*\))', v) if isinstance(v, str) else None
    return m.group(1) if m else None

def texto(v):
    """Texto limpo de uma célula (números inteiros viram '2025', não '2025.0')."""
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return clean_text(str(v))

ANO_ATUAL = datetime.date.today().year

rows = []
for _, r in mun.iterrows():
    situacao = norm_sit(col(r, 'Situação (Ente Federado)', 'Situação'))
    # "Diligência Documental" não conta como adesão efetiva — indica pendência
    # documental que ainda impede a formalização (decisão de 2026-09-15).
    aderiu = situacao not in ('Não possui adesão', 'Diligência Documental')
    st_sis = col(r, 'Situação da Lei do Sistema de Cultura')
    st_con = col(r, 'Situação da Lei do Conselho', 'Situação da Lei do Conselho de Política Cultural')
    st_fun = col(r, 'Situação da Lei do Fundo', 'Situação da Lei do Fundo de Cultura')
    st_pla = col(r, 'Situação do Plano de Cultura')
    st_org = col(r, 'Situação do Órgão Gestor')
    sistema = is_done(st_sis)
    conselho = is_done(st_con)
    fundo = is_done(st_fun)
    plano = is_done(st_pla)
    orgao = is_done(st_org)
    indice = sistema + conselho + fundo + plano + orgao if aderiu else 0

    vig = col(r, 'Último ano de vigência do Plano', 'Ultimo ano de vigência do Plano de Cultura')
    vig_year = None
    try:
        vig_year = int(vig)
    except (ValueError, TypeError):
        vig_year = None
    plano_vencido = 1 if (plano == 1 and vig_year is not None and vig_year < ANO_ATUAL) else 0

    # sem_info: aderiu mas nenhum dos 5 componentes tem QUALQUER dado enviado (todos "Não informado(a)").
    # Diferente de indice==0, que também inclui quem enviou algo mas ficou pendente
    # (arquivo incorreto/incompleto/danificado, anexo em avaliação).
    status_componentes = [norm_status(v) for v in (st_sis, st_con, st_fun, st_pla, st_org)]
    sem_info = aderiu and all((v == 'Não informado(a)' or v is None) for v in status_componentes)

    upd_raw = col(r, 'Última atualização (ente federado)', 'Última atualização')
    # "Aprovado"/"Rejeitado" do Plano de Trabalho ficam como estão (o dashboard usa esses termos)
    _pt = col(r, 'Situação do Plano de Trabalho')
    pt_raw = _pt.strip().capitalize() if isinstance(_pt, str) and _pt.strip().lower() in ('aprovado', 'rejeitado') else norm_status(_pt)
    siic_raw = col(r, 'Data SIIC')
    mon_raw = col(r, 'Plano monitorado')

    row = {
        "m": nome_municipio(r['Ente Federado'], r['Cod.IBGE']),
        "uf": r['UF'],
        "reg": str(r['Região']).replace('Centro-Oeste', 'Centro Oeste'),
        "ibge": int(r['Cod.IBGE']) if pd.notna(r['Cod.IBGE']) else None,
        "pop": int(col(r, 'População', 'População [2022]')) if pd.notna(col(r, 'População', 'População [2022]')) else None,
        "porte": porte_curto(r['Faixa Populacional']) if aderiu else None,
        "sit": situacao,
        "ad": aderiu,
        "dtAd": parse_date(r['Data Adesão']) if aderiu else None,
        "sis": sistema, "con": conselho, "fun": fundo, "pla": plano, "org": orgao, "idx": indice, "semInfo": sem_info,
        # status granular por componente (vocabulário normalizado), para checklists e relatórios detalhados
        "sisSt": clean_status(st_sis) if aderiu else None,
        "orgSt": clean_status(st_org) if aderiu else None,
        "conSt": clean_status(st_con) if aderiu else None,
        "ataSt": clean_status(col(r, 'Situação da Ata do Conselho', 'Situação da Ata do Conselho de Política Cultural')) if aderiu else None,
        "funSt": clean_status(st_fun) if aderiu else None,
        "plaSt": clean_status(st_pla) if aderiu else None,
        # datas e detalhes de cada lei/componente
        "sisData": parse_date(col(r, 'Data da Lei do Sistema de Cultura')),
        "orgData": parse_date(col(r, 'Data da Lei do Órgão Gestor')),
        "orgPerfil": clean_text(col(r, 'Perfil do Órgão Gestor')),
        "conData": parse_date(col(r, 'Data da Lei do Conselho', 'Data da Lei do Conselho de Política Cultural')),
        "conExcl": yn(col(r, 'Conselho exclusivo de cultura')),
        "conParit": yn(col(r, 'Conselho paritário')),
        "ataData": parse_date(col(r, 'Data da assinatura da ata da ultima reunião')),
        "funData": parse_date(col(r, 'Data da Lei do Fundo', 'Data da Lei do Fundo de Cultura')),
        "funCnpj": yn(col(r, 'Fundo de Cultura possui CNPJ')),
        "planoData": parse_date(col(r, 'Data do Plano de Cultura')),
        "periodicidade": clean_text(col(r, 'Periodicidade do Plano', 'Periocidade do Plano de Cultura')),
        "upd": parse_date(upd_raw.split(' às')[0]) if isinstance(upd_raw, str) else None,
        "pt": pt_raw if pt_raw not in (None, 'Não informado(a)', 'Nao possui adesão', 'Não possui adesão') else None,
        "acf": 1 if col(r, 'ACF incluído') == 'Sim' else 0,
        "vig": vig_year,
        "venc": plano_vencido,
        "mon": 1 if (isinstance(mon_raw, str) and mon_raw.startswith('Sim')) else 0,
        "pref": clean_text(col(r, 'Prefeito')),
        "emailPref": clean_text(col(r, 'Email Prefeito')),
        "cad": clean_text(col(r, 'Cadastrador')),
        "emailCad": clean_text(col(r, 'Email do Cadastrador')),
        "gestor": clean_text(col(r, 'Gestor de Cultura')),
        "emailGestor": clean_text(col(r, 'Email do Gestor de Cultura')),
        # Campos do Painel de Pendências (módulo independente):
        "siic": 1 if isinstance(siic_raw, str) and siic_raw.strip() not in SENTINEL_VALUES else 0,
        "confNac": 1 if col(r, 'Participou da Conferência Nacional') == 'Sim' else 0,
        # Campos da planilha nova (2026-11) — só existem no formato ente_federado.xlsx
        "cnpjEnte": fmt_cnpj(col(r, 'CNPJ Ente Federado')),
        "orgTemCnpj": yn(col(r, 'Órgão Gestor possui CNPJ')),
        "orgCnpj": fmt_cnpj(col(r, 'CNPJ do Órgão Gestor')),
        "formacao": yn(col(r, 'Participou de Programa de Formação')),
        "formacaoData": parse_date(col(r, 'Data Programa de Formação (fim das ações)')),
        "confAnos": texto(col(r, 'Data Conferência (anos)')),
        "setorial": yn(col(r, 'Possui Sistema Setorial')),
        "cib": parse_date(col(r, 'Data CIB')),
        "plaMetas": yn(col(r, 'Possui metas')),
        "metasSt": texto(col(r, 'Situação das metas')),
    }
    rows.append(row)

print("Total municípios:", len(rows))
print("Aderidos:", sum(1 for x in rows if x['ad']))

with open('snc_data.json', 'w', encoding='utf-8') as f:
    json.dump(rows, f, ensure_ascii=False, separators=(',', ':'))

import os
print("Tamanho JSON (KB):", os.path.getsize('snc_data.json') / 1024)

# ── Extração dos estados como entes federados ──────────────────────────────
df_est = df[df['Ente Federado'].str.match(ESTADO_RE, na=False)].copy()

def clean_estado(v):
    if v is None or (isinstance(v, float) and pd.isna(v)): return None
    if isinstance(v, float) and v.is_integer(): v = int(v)
    v = str(v).strip()
    return None if v in SENTINEL_VALUES or v in ('', 'nan') else v

def parse_date_str(v):
    if not isinstance(v, str): return None
    import re as re2
    m = re2.match(r'(\d{2})/(\d{2})/(\d{4})', v.strip())
    if m:
        d, mo, y = m.groups()
        return f'{y}-{mo}-{d}'
    return None

def nome_estado(v):
    # "Estado do Acre" -> "Acre"; "ESTADO DA BAHIA" -> "Bahia"
    nome = re.sub(ESTADO_RE, '', str(v)).strip()
    if nome.isupper():
        nome = ' '.join(p.lower() if p.lower() in ('de', 'do', 'da', 'dos', 'das') else p.capitalize() for p in nome.split())
    return nome

estados_rows = []
for _, r in df_est.iterrows():
    def g(*cols): return clean_estado(col(r, *cols))
    def st(*cols): return clean_estado(norm_status(col(r, *cols)))
    def d(*cols):
        v = col(r, *cols)
        return parse_date_str(str(v)[:10] if isinstance(v, str) else '')
    def b(*cols): v = col(r, *cols); return True if str(v).strip() == 'Sim' else (False if str(v).strip() == 'Não' else None)

    vig_raw = col(r, 'Último ano de vigência do Plano', 'Ultimo ano de vigência do Plano de Cultura')
    try: vig = int(float(vig_raw)) if str(vig_raw).strip() not in ('', 'nan', 'None', 'Não informado(a)') else None
    except: vig = None

    upd_raw = col(r, 'Última atualização (ente federado)', 'Última atualização')
    upd = parse_date_str(str(upd_raw)[:10]) if isinstance(upd_raw, str) else None

    # Formato antigo trazia o número do CNPJ do fundo; o novo traz só "possui CNPJ" (Sim/Não)
    fun_cnpj = g('CNPJ do Fundo de Cultura') or (True if b('Fundo de Cultura possui CNPJ') else None)

    estados_rows.append({
        # Identificação
        'uf': str(r['UF']).strip(),
        'nome': nome_estado(r['Ente Federado']),
        'reg': (g('Região') or '').replace('Centro-Oeste', 'Centro Oeste') or None,
        # Situação geral
        'sit': norm_sit(col(r, 'Situação (Ente Federado)', 'Situação')),
        'dtAd': parse_date_str(col(r, 'Data Adesão')),
        # Componentes (boolean)
        'sis': is_done(col(r, 'Situação da Lei do Sistema de Cultura')),
        'org': is_done(col(r, 'Situação do Órgão Gestor')),
        'con': is_done(col(r, 'Situação da Lei do Conselho', 'Situação da Lei do Conselho de Política Cultural')),
        'fun': is_done(col(r, 'Situação da Lei do Fundo', 'Situação da Lei do Fundo de Cultura')),
        'pla': is_done(col(r, 'Situação do Plano de Cultura')),
        # Situação detalhada dos componentes
        'sisSt': st('Situação da Lei do Sistema de Cultura'),
        'sisData': d('Data da Lei do Sistema de Cultura'),
        'orgSt': st('Situação do Órgão Gestor'),
        'orgData': d('Data da Lei do Órgão Gestor'),
        'orgPerfil': g('Perfil do Órgão Gestor'),
        'orgCnpj': fmt_cnpj(col(r, 'CNPJ do Órgão Gestor', 'CNPJ do Órgão Gestor de Cultura')),
        'conSt': st('Situação da Lei do Conselho', 'Situação da Lei do Conselho de Política Cultural'),
        'conData': d('Data da Lei do Conselho', 'Data da Lei do Conselho de Política Cultural'),
        'conAtaSt': st('Situação da Ata do Conselho', 'Situação da Ata do Conselho de Política Cultural'),
        'conAta': b('Possui ata da última reunião', 'Possui ata da última reunião do conselho'),
        'conAtaData': d('Data da última reunião do conselho', 'Data da assinatura da ata da ultima reunião'),
        'conExcl': b('Conselho exclusivo de cultura'),
        'conParit': b('Conselho paritário'),
        'conNatureza': g('Natureza do Conselho'),
        'funSt': st('Situação da Lei do Fundo', 'Situação da Lei do Fundo de Cultura'),
        'funData': d('Data da Lei do Fundo', 'Data da Lei do Fundo de Cultura'),
        'funCnpj': fun_cnpj,
        'plaSt': st('Situação do Plano de Cultura'),
        'plaData': d('Data do Plano de Cultura'),
        'vig': vig,
        'plaPeriodicidade': g('Periodicidade do Plano', 'Periocidade do Plano de Cultura'),
        'plaMetas': b('Possui metas'),
        'plaMonitorado': g('Plano monitorado'),
        # Participação
        'confNac': b('Participou da Conferência Nacional'),
        'formacao': b('Participou de Programa de Formação', 'Participou de algum Programa de Formação de Gestores e Conselheiros Culturais'),
        # Contatos
        'governador': g('Prefeito'),
        'emailGov': g('Email Prefeito'),
        'tel': g('Telefone'),
        'cad': g('Cadastrador'),
        'emailCad': g('Email do Cadastrador'),
        'gestor': g('Gestor de Cultura'),
        'emailGestor': g('Email do Gestor de Cultura'),
        # Processo
        'sei': g('Num. Processo SEI', 'Num. Processo Sei'),
        # Atualização
        'upd': upd,
        # Campos da planilha nova (2026-11)
        'cnpjEnte': fmt_cnpj(col(r, 'CNPJ Ente Federado')),
        'orgTemCnpj': b('Órgão Gestor possui CNPJ'),
        'setorial': b('Possui Sistema Setorial'),
        'confAnos': texto(col(r, 'Data Conferência (anos)')),
        'cib': d('Data CIB'),
    })

# Gera data.js com municípios E dados estaduais
with open('data.js', 'w', encoding='utf-8') as f:
    f.write('// Dados oficiais SNC (gerado automaticamente)\n')
    f.write('const SNC_DEFAULT_DATA = ')
    f.write(json.dumps(rows, ensure_ascii=False, separators=(',', ':')))
    f.write(';\n')
    f.write('const SNC_ESTADOS_DATA = ')
    f.write(json.dumps({r['uf']: r for r in estados_rows}, ensure_ascii=False, separators=(',', ':')))
    f.write(';\n')
    f.write('const SNC_DATA_META = ')
    import datetime
    f.write(json.dumps({'fonte': os.path.basename(ARQUIVO), 'gerado': datetime.date.today().isoformat()}, ensure_ascii=False))
    f.write(';\n')

import os
print("data.js gerado:", os.path.getsize('data.js') / 1024, "KB")

print("Estados extraídos:", len(estados_rows))

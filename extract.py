import pandas as pd
import json
import re

df = pd.read_excel('/mnt/user-data/uploads/dados-municipios-cadastrados-snc__2_.xls', sheet_name='SNC')
mun = df[~df['Ente Federado'].str.startswith('Estado de')].copy()
# Remove duplicidade do Distrito Federal: a planilha traz "Distrito Federal" (ibge=53, com
# adesão publicada) e também "Brasília" (ibge=5300108, "Nao possui adesão") como o mesmo ente.
# Mantém apenas "Distrito Federal" (situação real e correta) para não contar o DF duas vezes.
mun = mun[~((mun['UF'] == 'DF') & (mun['Ente Federado'] == 'Brasília'))].copy()

def is_done(v):
    return 1 if v == 'Concluída' else 0

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
    if not isinstance(v, str):
        return None
    return v

SENTINEL_VALUES = {'Não informado(a)', 'Nao possui adesão', 'Não possui adesão'}

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

PORTE_MAP = {
    'Porte 1 (Pequeno I): até 20 mil habitantes': 'Porte 1 (Pequeno I)',
    'Porte 2 (Pequeno II): de 20.001 a 50 mil habitantes': 'Porte 2 (Pequeno II)',
    'Porte 3 (Médio): de 50.001 a 100 mil habitantes': 'Porte 3 (Médio)',
    'Porte 4 (Grande I): de 100.001 a 900 mil habitantes': 'Porte 4 (Grande I)',
    'Porte 5 (Grande II): acima de 900 mil habitantes': 'Porte 5 (Grande II)',
}

rows = []
for _, r in mun.iterrows():
    situacao = r['Situação']
    aderiu = situacao != 'Nao possui adesão'
    sistema = is_done(r['Situação da Lei do Sistema de Cultura'])
    conselho = is_done(r['Situação da Lei do Conselho de Política Cultural'])
    fundo = is_done(r['Situação da Lei do Fundo de Cultura'])
    plano = is_done(r['Situação do Plano de Cultura'])
    orgao = is_done(r['Situação do Órgão Gestor'])
    indice = sistema + conselho + fundo + plano + orgao if aderiu else 0

    vig = r['Ultimo ano de vigência do Plano de Cultura']
    vig_year = None
    try:
        vig_year = int(vig)
    except (ValueError, TypeError):
        vig_year = None
    plano_vencido = 1 if (plano == 1 and vig_year is not None and vig_year < 2026) else 0

    row = {
        "m": r['Ente Federado'],
        "uf": r['UF'],
        "reg": r['Região'],
        "ibge": int(r['Cod.IBGE']) if pd.notna(r['Cod.IBGE']) else None,
        "pop": int(r['População [2022]']) if pd.notna(r['População [2022]']) else None,
        "porte": PORTE_MAP.get(r['Faixa Populacional']) if aderiu else None,
        "sit": situacao.replace("Nao possui adesão", "Não possui adesão"),
        "ad": aderiu,
        "dtAd": parse_date(r['Data Adesão']) if aderiu else None,
        "sis": sistema, "con": conselho, "fun": fundo, "pla": plano, "org": orgao, "idx": indice,
        # status granular (texto bruto da planilha) por componente, para checklists e relatórios detalhados
        "sisSt": clean_status(r['Situação da Lei do Sistema de Cultura']) if aderiu else None,
        "orgSt": clean_status(r['Situação do Órgão Gestor']) if aderiu else None,
        "conSt": clean_status(r['Situação da Lei do Conselho de Política Cultural']) if aderiu else None,
        "ataSt": clean_status(r['Situação da Ata do Conselho de Política Cultural']) if aderiu else None,
        "funSt": clean_status(r['Situação da Lei do Fundo de Cultura']) if aderiu else None,
        "plaSt": clean_status(r['Situação do Plano de Cultura']) if aderiu else None,
        # datas e detalhes de cada lei/componente
        "sisData": parse_date(r['Data da Lei do Sistema de Cultura']),
        "orgData": parse_date(r['Data da Lei do Órgão Gestor']),
        "orgPerfil": clean_text(r['Perfil do Órgão Gestor']),
        "conData": parse_date(r['Data da Lei do Conselho de Política Cultural']),
        "conExcl": yn(r['Conselho exclusivo de cultura']),
        "conParit": yn(r['Conselho paritário']),
        "ataData": parse_date(r['Data da assinatura da ata da ultima reunião']),
        "funData": parse_date(r['Data da Lei do Fundo de Cultura']),
        "planoData": parse_date(r['Data do Plano de Cultura']),
        "periodicidade": clean_text(r['Periocidade do Plano de Cultura']),
        "upd": parse_date(r['Última atualização'].split(' às')[0]) if isinstance(r['Última atualização'], str) else None,
        "pt": r['Situação do Plano de Trabalho'] if r['Situação do Plano de Trabalho'] not in ('Não informado(a)', 'Nao possui adesão') else None,
        "acf": 1 if r['ACF incluído'] == 'Sim' else 0,
        "vig": vig_year,
        "venc": plano_vencido,
        "mon": 1 if (isinstance(r['Plano monitorado'], str) and r['Plano monitorado'].startswith('Sim')) else 0,
        "pref": clean_text(r['Prefeito']),
        "emailPref": clean_text(r['Email Prefeito']),
        "cad": clean_text(r['Cadastrador']),
        "emailCad": clean_text(r['Email do Cadastrador']),
        "gestor": clean_text(r['Gestor de Cultura']),
        "emailGestor": clean_text(r['Email do Gestor de Cultura']),
        # Campos do Painel de Pendências (módulo independente):
        "siic": 1 if isinstance(r['Data SIIC'], str) and r['Data SIIC'] not in ('Não informado(a)', 'Nao possui adesão') else 0,
        "confNac": 1 if r['Participou da Conferência Nacional'] == 'Sim' else 0,
    }
    rows.append(row)

print("Total municípios:", len(rows))
print("Aderidos:", sum(1 for x in rows if x['ad']))

with open('snc_data.json', 'w', encoding='utf-8') as f:
    json.dump(rows, f, ensure_ascii=False, separators=(',', ':'))

import os
print("Tamanho JSON (KB):", os.path.getsize('snc_data.json') / 1024)

# ── Extração dos estados como entes federados ──────────────────────────────
df_est = df[df['Ente Federado'].str.startswith('Estado de', na=False)].copy()

def clean_estado(v):
    if not isinstance(v, str): return None
    v = v.strip()
    return None if v in ('Não informado(a)', 'Nao possui adesão', '') else v

def parse_date_str(v):
    if not isinstance(v, str): return None
    import re as re2
    m = re2.match(r'(\d{2})/(\d{2})/(\d{4})', v.strip())
    if m:
        d, mo, y = m.groups()
        return f'{y}-{mo}-{d}'
    return None

estados_rows = []
for _, r in df_est.iterrows():
    def g(col): return clean_estado(r.get(col, ''))
    def d(col): return parse_date_str(str(r.get(col, ''))[:10] if isinstance(r.get(col, ''), str) else '')
    def b(col): v = r.get(col, ''); return True if str(v).strip() == 'Sim' else (False if str(v).strip() == 'Não' else None)
    def n(col):
        v = r.get(col, '')
        try: return int(float(v)) if str(v).strip() not in ('', 'nan', 'Não informado(a)') else None
        except: return None

    vig_raw = r.get('Ultimo ano de vigência do Plano de Cultura', '')
    try: vig = int(float(vig_raw)) if str(vig_raw).strip() not in ('', 'nan', 'Não informado(a)') else None
    except: vig = None

    upd_raw = r.get('Última atualização', '')
    upd = parse_date_str(str(upd_raw)[:10]) if isinstance(upd_raw, str) else None

    estados_rows.append({
        # Identificação
        'uf': str(r['UF']).strip(),
        'nome': str(r['Ente Federado']).replace('Estado de ', '').replace('Estado do ', '').replace('Estado da ', '').strip(),
        'reg': g('Região'),
        # Situação geral
        'sit': clean_estado(r['Situação']) or 'Não possui adesão',
        'dtAd': parse_date_str(r.get('Data Adesão', '')),
        # Componentes (boolean)
        'sis': 1 if r['Situação da Lei do Sistema de Cultura'] == 'Concluída' else 0,
        'org': 1 if r['Situação do Órgão Gestor'] == 'Concluída' else 0,
        'con': 1 if r['Situação da Lei do Conselho de Política Cultural'] == 'Concluída' else 0,
        'fun': 1 if r['Situação da Lei do Fundo de Cultura'] == 'Concluída' else 0,
        'pla': 1 if r['Situação do Plano de Cultura'] == 'Concluída' else 0,
        # Situação detalhada dos componentes
        'sisSt': g('Situação da Lei do Sistema de Cultura'),
        'sisData': d('Data da Lei do Sistema de Cultura'),
        'orgSt': g('Situação do Órgão Gestor'),
        'orgData': d('Data da Lei do Órgão Gestor'),
        'orgPerfil': g('Perfil do Órgão Gestor'),
        'orgCnpj': g('CNPJ do Órgão Gestor de Cultura'),
        'conSt': g('Situação da Lei do Conselho de Política Cultural'),
        'conData': d('Data da Lei do Conselho de Política Cultural'),
        'conAtaSt': g('Situação da Ata do Conselho de Política Cultural'),
        'conAta': b('Possui ata da última reunião do conselho'),
        'conAtaData': d('Data da assinatura da ata da ultima reunião'),
        'conExcl': b('Conselho exclusivo de cultura'),
        'conParit': b('Conselho paritário'),
        'conNatureza': g('Natureza do Conselho'),
        'funSt': g('Situação da Lei do Fundo de Cultura'),
        'funData': d('Data da Lei do Fundo de Cultura'),
        'funCnpj': g('CNPJ do Fundo de Cultura'),
        'plaSt': g('Situação do Plano de Cultura'),
        'plaData': d('Data do Plano de Cultura'),
        'vig': vig,
        'plaPeriodicidade': g('Periocidade do Plano de Cultura'),
        'plaMetas': b('Possui metas'),
        'plaMonitorado': g('Plano monitorado'),
        # Participação
        'confNac': b('Participou da Conferência Nacional'),
        'formacao': b('Participou de algum Programa de Formação de Gestores e Conselheiros Culturais'),
        # Contatos
        'governador': g('Prefeito'),
        'emailGov': g('Email Prefeito'),
        'tel': g('Telefone'),
        'cad': g('Cadastrador'),
        'emailCad': g('Email do Cadastrador'),
        'gestor': g('Gestor de Cultura'),
        'emailGestor': g('Email do Gestor de Cultura'),
        # Processo
        'sei': g('Num. Processo Sei'),
        # Atualização
        'upd': upd,
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
    f.write(json.dumps({'fonte': 'dados-municipios-cadastrados-snc.xls', 'gerado': datetime.date.today().isoformat()}, ensure_ascii=False))
    f.write(';\n')

import os
print("data.js gerado:", os.path.getsize('data.js') / 1024, "KB")
print("Estados extraídos:", len(estados_rows))

/**
 * Localisation from `window.nimiqPay.language`. Minimum en/es/de/fr/pt (PRD 7).
 * Keys fall back to English for any missing string, so a partial translation
 * never shows a blank — degrade to usable, never to silence.
 */
export type Lang = 'en' | 'es' | 'de' | 'fr' | 'pt';
export const LANGS: Lang[] = ['en', 'es', 'de', 'fr', 'pt'];

export type Dict = Record<string, string>;

const en: Dict = {
  'app.name': 'Tally',
  'ledger.settleUp': 'Settle up',
  'ledger.callTab': 'Call the tab',
  'ledger.netPosition': 'Net position',
  'ledger.youAreOwed': 'You are owed',
  'ledger.youOwe': 'You owe',
  'ledger.settled': 'Settled up',
  'round.sending': 'Sending',
  'round.landed': 'Settled',
  'round.waitingOn': 'Waiting on {name} to open Tally',
  'round.expiresIn': 'Expires in {time}',
  'obligation.accept': 'Accept',
  'obligation.reject': 'Reject',
  'obligation.add': 'Add expense',
  'purse.sign': 'Sign the binding',
  'purse.skip': 'Skip — settle manually',
  'purse.title': 'Sign once, settle without dialogs',
  'degraded.declined': 'No problem — nothing was sent. You can try again any time.',
  'degraded.offline': 'Offline — showing your last synced view. New entries sync when you reconnect.',
  'degraded.consensusLost': 'Reconnecting to the network — settlement is paused, but you can still record expenses.',
  'degraded.forked': 'This ledger has diverged. A round cannot open until it reconciles.',
  'network.testnet': 'Testnet',
};

const es: Dict = {
  'ledger.settleUp': 'Saldar',
  'ledger.callTab': 'Cerrar la cuenta',
  'obligation.add': 'Añadir gasto',
  'purse.skip': 'Omitir — saldar manualmente',
  'degraded.declined': 'Sin problema — no se envió nada. Puedes intentarlo cuando quieras.',
};
const de: Dict = {
  'ledger.settleUp': 'Ausgleichen',
  'ledger.callTab': 'Abrechnen',
  'obligation.add': 'Ausgabe hinzufügen',
  'purse.skip': 'Überspringen — manuell ausgleichen',
  'degraded.declined': 'Kein Problem — es wurde nichts gesendet. Du kannst es jederzeit erneut versuchen.',
};
const fr: Dict = {
  'ledger.settleUp': 'Régler',
  'ledger.callTab': "Clôturer l'ardoise",
  'obligation.add': 'Ajouter une dépense',
  'purse.skip': 'Passer — régler manuellement',
  'degraded.declined': "Pas de souci — rien n'a été envoyé. Vous pouvez réessayer à tout moment.",
};
const pt: Dict = {
  'ledger.settleUp': 'Acertar',
  'ledger.callTab': 'Fechar a conta',
  'obligation.add': 'Adicionar despesa',
  'purse.skip': 'Ignorar — acertar manualmente',
  'degraded.declined': 'Sem problema — nada foi enviado. Pode tentar novamente quando quiser.',
};

const DICTS: Record<Lang, Dict> = { en, es, de, fr, pt };

export function normalizeLang(raw: string | undefined): Lang {
  const short = (raw ?? 'en').slice(0, 2).toLowerCase();
  return (LANGS as string[]).includes(short) ? (short as Lang) : 'en';
}

export class Translator {
  readonly lang: Lang;
  readonly #dict: Dict;
  constructor(lang: Lang) {
    this.lang = lang;
    this.#dict = { ...en, ...DICTS[lang] }; // English fallback for missing keys
  }
  t(key: string, vars?: Record<string, string>): string {
    let s = this.#dict[key] ?? en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
    return s;
  }
}

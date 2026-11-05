/** Well-known British mountains to start from: summit grid references (OS) and heights. */
export interface Peak {
  id: string;
  name: string;
  ref: string;
  height: number;
}

export const PEAKS: Peak[] = [
  { id: "ben-nevis", name: "Ben Nevis", ref: "NN 16667 71283", height: 1345 },
  { id: "ben-macdui", name: "Ben Macdui", ref: "NN 98892 98951", height: 1309 },
  { id: "cairn-gorm", name: "Cairn Gorm", ref: "NJ 00513 04063", height: 1245 },
  { id: "ben-lawers", name: "Ben Lawers", ref: "NN 63600 41400", height: 1214 },
  { id: "lochnagar", name: "Lochnagar", ref: "NO 24392 86135", height: 1156 },
  { id: "schiehallion", name: "Schiehallion", ref: "NN 71379 54740", height: 1083 },
  { id: "an-teallach", name: "An Teallach", ref: "NH 06900 84400", height: 1062 },
  { id: "liathach", name: "Liathach", ref: "NG 92900 57900", height: 1055 },
  { id: "buachaille", name: "Buachaille Etive Mòr", ref: "NN 22305 54278", height: 1022 },
  { id: "sgurr-alasdair", name: "Sgùrr Alasdair (Skye)", ref: "NG 45000 20800", height: 992 },
  { id: "ben-lomond", name: "Ben Lomond", ref: "NN 36717 02856", height: 974 },
  { id: "snowdon", name: "Yr Wyddfa / Snowdon", ref: "SH 60971 54366", height: 1085 },
  { id: "scafell-pike", name: "Scafell Pike", ref: "NY 21542 07215", height: 978 },
  { id: "helvellyn", name: "Helvellyn", ref: "NY 34217 15128", height: 950 },
  { id: "pen-y-fan", name: "Pen y Fan", ref: "SO 01200 21500", height: 886 },
];

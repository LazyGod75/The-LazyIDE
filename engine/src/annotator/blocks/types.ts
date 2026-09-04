export interface InfoboxRow {
  label: string;
  value: string;
}

export interface InInfobox {
  rows: InfoboxRow[];
}

export interface InLeadSection {
  subject: string;
  description: string;
}

export interface TocEntry {
  level: number;
  id: string;
  text: string;
}

export interface InToc {
  entries: TocEntry[];
}

export interface InDataTable {
  caption: string;
  headers: string[];
  rows: string[][];
  sortable?: boolean;
}

export interface SeeAlsoLink {
  id: string;
  title: string;
}

export interface InSeeAlso {
  links: SeeAlsoLink[];
}

export interface InCategories {
  tags: string[];
}

export interface InJsonLd {
  title: string;
  type: string;
  dateCreated: string;
  tags: string[];
  description?: string;
}

export interface InGlossary {
  entities: string[];
}

export interface QaPair {
  question: string;
  answer: string;
}

export interface InQaSection {
  pairs: QaPair[];
}

export interface Fact {
  text: string;
  confidence: number;
  kind: string;
  extractor?: string;
}

export interface InFactsSection {
  facts: Fact[];
  tldr?: string;
}

export interface InToolTrace {
  facts: Fact[];
  tool?: string;
}

export interface InErrors {
  facts: Fact[];
}

export interface InOutcome {
  replaces?: string[];
}

export interface InCounterfactuals {
  facts: Fact[];
}

export interface InAntipatterns {
  facts: Fact[];
}

export interface InReferences {
  filesModified?: string[];
  filesRead?: string[];
}

export interface InMetaHead {
  answers: string;
  aliases: string;
  commitRef?: string | null;
  backlinkCount?: number | null;
}

export type BlockRenderer<T> = (input: T) => string;

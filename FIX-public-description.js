'use strict';

const DESCRIPTION_VERSION = 'public-description-v1';

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function disclosedValue(deal) {
  const value = text(deal?.dealValue);
  return value && !/^(?:undisclosed|unknown|\$0(?:\.0+)?|0)$/i.test(value) ? value : null;
}

function perShareValue(deal) {
  const value = Number(deal?.perShare);
  if (!Number.isFinite(value) || value <= 0 || value >= 100000) return null;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 4 })} per share`;
}

function considerationClause(deal) {
  const perShare = perShareValue(deal);
  if (perShare) return ` for ${perShare}`;
  const value = disclosedValue(deal);
  return value ? ` in a transaction valued at ${value}` : '';
}

function transactionSentence(deal) {
  const acquirer = text(deal?.acquirer);
  const target = text(deal?.target);
  if (!acquirer || !target) return '';
  const value = considerationClause(deal);

  switch (text(deal?.dealType)) {
    case 'Acquisition':
      return `${acquirer} agreed to acquire ${target}${value}.`;
    case 'Merger / Business Combination':
    case 'Merger':
      return `${acquirer} and ${target} are parties to a merger or business combination${value}.`;
    case 'Tender Offer':
      return `${acquirer} launched a tender offer for ${target}${value}.`;
    case 'LBO / Going-Private':
    case 'Going-Private':
      return `${acquirer} agreed to acquire ${target} in a going-private transaction${value}.`;
    case 'Divestiture / Carve-Out':
    case 'Divestiture':
      return `${acquirer} agreed to acquire ${target} in a divestiture or carve-out transaction${value}.`;
    default:
      return `${acquirer} and ${target} are parties to an announced M&A transaction${value}.`;
  }
}

function sourceSentence(deal) {
  const date = text(deal?.date);
  const form = text(deal?.filingType);
  const sourceType = text(deal?.sourceType || deal?.extractionMethod).toLowerCase();
  if (form || sourceType.includes('sec')) {
    return `The transaction is documented${form ? ` in SEC Form ${form}` : ' in an SEC filing'}${date ? ` filed on ${date}` : ''}.`;
  }
  const sourceName = text(deal?.sourceName || deal?.source);
  if (sourceName) return `The transaction is documented by ${sourceName}${date ? ` on ${date}` : ''}.`;
  return date ? `The transaction was announced on ${date}.` : 'The transaction is supported by the linked primary source.';
}

function withPublicDescription(deal) {
  const summary = transactionSentence(deal);
  const body = sourceSentence(deal);
  if (!summary) return { ...deal };
  return {
    ...deal,
    headline: `${text(deal.acquirer)} / ${text(deal.target)}`,
    summary,
    body,
    descriptionVersion: DESCRIPTION_VERSION,
  };
}

module.exports = {
  DESCRIPTION_VERSION,
  disclosedValue,
  perShareValue,
  considerationClause,
  transactionSentence,
  sourceSentence,
  withPublicDescription,
};

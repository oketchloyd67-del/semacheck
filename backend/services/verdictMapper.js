// Pure function: signals -> verdict, confidence, reasons.
// No database or network access, so it is fully unit-testable.

const THRESHOLDS = {
  scamVoteMargin: 0,
  governmentScamWeight: 4,
  maxBreachScore: 97,
  knownVerified: 96,
  knownVerifiedVote: 95,
  suspiciousMax: 80,
  defaultUnverified: 30,
};

const VERDICT_LABELS = {
  reported: 'Reported',
  caution: 'Caution',
  registered: 'Registered',
  unverified: 'Unverified',
};

const SOURCE_LABELS = {
  reports: 'SemaCheck reports',
  cbk: 'CBK licensed lender registry',
  external: 'Current web results',
  international: 'International scam databases',
};

function verdictMapper(signals) {
  const scamVotes = Number(signals.scamVotes || 0);
  const legitVotes = Number(signals.legitVotes || 0);
  const cbkMatch = !!signals.cbkMatch;
  const internationalScamScore = Number(signals.internationalScamScore || 0);
  const externalBreachScore = Number(signals.externalBreachScore || 0);
  const hasGovernmentScamHit = !!signals.hasGovernmentScamHit;
  const hasDispute = !!signals.hasDispute;

  const reasons = [];
  const weights = [];

  const isScam = scamVotes > legitVotes || hasGovernmentScamHit || externalBreachScore >= THRESHOLDS.governmentScamWeight || internationalScamScore >= 20;

  let verdict;
  let confidence;

  if (isScam) {
    verdict = 'reported';
    const score = Math.min(THRESHOLDS.maxBreachScore, 55 + scamVotes * 5 + externalBreachScore * 5 + internationalScamScore + (hasGovernmentScamHit ? 15 : 0));
    confidence = score;
    if (scamVotes > legitVotes) reasons.push({ code: 'reported', label: 'Some SemaCheck reports link this subject to a scam.', source: 'reports', weight: 8 });
    if (scamVotes > 0) reasons.push({ code: 'reported_count', label: 'Multiple reports exist on this subject.', source: 'reports', weight: 4 });
    if (hasGovernmentScamHit) reasons.push({ code: 'government_hit', label: 'A Kenyan government or regulator source flags this subject.', source: 'external', weight: 15 });
    if (externalBreachScore > 0) reasons.push({ code: 'web_result', label: 'Current web results point to fraudulent activity.', source: 'external', weight: 4 });
    if (internationalScamScore > 0) reasons.push({ code: 'international', label: 'International scam tracker matches.', source: 'international', weight: 3 });
  } else if (cbkMatch && externalBreachScore === 0 && internationalScamScore === 0) {
    verdict = 'registered';
    confidence = Math.min(THRESHOLDS.knownVerified, 82 + legitVotes * 3);
    reasons.push({ code: 'cbk_match', label: 'This subject matches a licensed digital lender on the CBK registry.', source: 'cbk', weight: 10 });
  } else if (legitVotes > 0 && externalBreachScore === 0 && internationalScamScore === 0) {
    verdict = 'registered';
    confidence = Math.min(THRESHOLDS.knownVerifiedVote, 55 + legitVotes * 8);
    reasons.push({ code: 'legit_vote', label: 'Previous searches show this subject as legitimate.', source: 'reports', weight: 5 });
  } else if (!signals.externalAvailable && scamVotes === 0 && !cbkMatch && internationalScamScore === 0) {
    verdict = 'unverified';
    confidence = THRESHOLDS.defaultUnverified;
    reasons.push({ code: 'unverified', label: 'Nothing yet flags or agrees with this subject. It is unverified.', source: 'internal', weight: 0 });
  } else {
    verdict = 'caution';
    confidence = Math.min(THRESHOLDS.suspiciousMax, 45 + externalBreachScore * 4 + internationalScamScore * 2);
    if (externalBreachScore > 0) reasons.push({ code: 'web_result', label: 'Current web results raise caution.', source: 'external', weight: 3 });
    if (internationalScamScore > 0) reasons.push({ code: 'international', label: 'International scam tracker raises caution.', source: 'international', weight: 2 });
    if (hasDispute) reasons.push({ code: 'disputed', label: 'A dispute is open. This result is capped at Caution while it is open.', source: 'reports', weight: 3 });
  }

  if (hasDispute) {
    if (verdict === 'reported' && !hasGovernmentScamHit) {
      verdict = 'caution';
      reasons.push({ code: 'disputed', label: 'A dispute is open. This result is capped at Caution while it is open.', source: 'reports', weight: 3 });
    }
    confidence = Math.max(0, confidence - 15);
  }

  const displayVerdict = VERDICT_LABELS[verdict] || verdict;
  return { verdict, confidence, reasons, displayVerdict, weights };
}

module.exports = { verdictMapper, THRESHOLDS, VERDICT_LABELS, SOURCE_LABELS };

export class NeedsInputError extends Error {
  constructor(message, requirements = [], details = {}) {
    super(message);
    this.name = "NeedsInputError";
    this.requirements = requirements;
    this.checkpoint = details.checkpoint;
    this.phase = details.phase;
    this.preparedAnswers = details.preparedAnswers;
    this.metrics = details.metrics;
  }
}

export class NeedsReviewError extends Error {
  constructor(message, requirements = [], details = {}) {
    super(message);
    this.name = "NeedsReviewError";
    this.requirements = requirements;
    this.checkpoint = details.checkpoint;
    this.phase = details.phase;
    this.preparedAnswers = details.preparedAnswers;
    this.metrics = details.metrics;
  }
}

export class NeedsResearchError extends Error {
  constructor(message, questions = [], details = {}) {
    super(message);
    this.name = "NeedsResearchError";
    this.questions = questions;
    this.checkpoint = details.checkpoint;
    this.phase = details.phase;
    this.preparedAnswers = details.preparedAnswers;
    this.metrics = details.metrics;
  }
}

export class PostingUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PostingUnavailableError";
    this.reasonCode = details.reasonCode;
    this.metrics = details.metrics;
  }
}

export class RetryableExecutionError extends Error {
  constructor(message) {
    super(message);
    this.name = "RetryableExecutionError";
  }
}

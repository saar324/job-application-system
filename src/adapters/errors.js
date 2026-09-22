export class NeedsInputError extends Error {
  constructor(message, requirements = []) {
    super(message);
    this.name = "NeedsInputError";
    this.requirements = requirements;
  }
}

export class NeedsReviewError extends Error {
  constructor(message, requirements = []) {
    super(message);
    this.name = "NeedsReviewError";
    this.requirements = requirements;
  }
}

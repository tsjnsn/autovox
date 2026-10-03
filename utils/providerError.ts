/** A provider request failed; `status` is the HTTP status when there was one. */
export class OpenAIError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'OpenAIError';
  }
}

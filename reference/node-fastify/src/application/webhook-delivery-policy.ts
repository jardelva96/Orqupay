export function isPermanentWebhookFailure(statusCode: number | undefined): boolean {
  if (statusCode === undefined) {
    return false;
  }
  if (statusCode === 408 || statusCode === 425 || statusCode === 429) {
    return false;
  }
  return statusCode >= 400 && statusCode < 500;
}

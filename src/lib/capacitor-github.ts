/**
 * Native GitHub sign-in was tied to the old Firebase Auth setup and is not
 * available in the self-hosted Pocket ID build. Use the Pocket ID login flow.
 */
export async function signInWithGitHubNative(): Promise<boolean> {
  return false;
}

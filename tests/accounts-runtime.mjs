// Native workerd test: no sockets, network requests, secrets or account data.
export const redirectCompatibility = {
  test() {
    let rejected = false;
    try {
      new Request('https://accounts.example.test/session', { redirect: 'error' });
    } catch (error) {
      rejected = error instanceof TypeError && error.message.startsWith(
        'Invalid redirect value, must be one of "follow" or "manual"',
      );
    }
    if (!rejected) throw new Error('Expected workerd to reject unsupported redirect mode');
    const request = new Request('https://accounts.example.test/session', {
      method: 'POST', body: '{}', redirect: 'manual', signal: AbortSignal.timeout(5000),
    });
    if (request.redirect !== 'manual' || !(request.signal instanceof AbortSignal))
      throw new Error('Expected supported manual redirect and timeout signal');
  },
};

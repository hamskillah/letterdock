export default {
  async email(message, env) {
    const id = crypto.randomUUID();
    try {
      const stream = new FixedLengthStream(message.rawSize);
      await Promise.all([
        message.raw.pipeTo(stream.writable),
        env.STAGING.put('mail/' + id, stream.readable, {
          customMetadata: { from: message.from, to: message.to }
        })
      ]);
    } catch (error) {
      console.error('Staging write failed', id, error);
      throw error;
    }
  }
};

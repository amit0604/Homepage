import React from 'react';
import TeamsChatPanel from './TeamsChatPanel';

/**
 * Chat tab: Teams-style layout (channels, DMs, search, files, reactions).
 */
function LobbyChatPage() {
  return (
    <section className="lobby-page" aria-label="Chat">
      <div className="lobby-page__inner lobby-page__inner--wide">
        <header className="lobby-page__intro">
          <h1 className="lobby-page__title">Chat</h1>
          <p className="lobby-page__tagline">
            configurable retention (default 30 days) · attachments up to 10
            MB
          </p>
        </header>
        <div className="lobby-page__panel lobby-page__panel--wide">
          <TeamsChatPanel />
        </div>
      </div>
    </section>
  );
}

export default LobbyChatPage;

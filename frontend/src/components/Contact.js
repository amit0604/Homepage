import React, { useState, useEffect } from 'react';

function Contact() {
  const [contacts, setContacts] = useState([]);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/public')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (!cancelled) {
          setContacts(Array.isArray(data.contacts) ? data.contacts : []);
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section id="contact">
      {loadError && (
        <p className="error-message" style={{ marginBottom: '12px' }}>
          Could not load contacts: {loadError}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Number</th>
            <th>Name</th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((contact, index) => (
            <tr key={`${contact.phone}-${contact.name}-${index}`}>
              <td>{contact.title}</td>
              <td>{contact.phone}</td>
              <td>{contact.name}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default Contact;

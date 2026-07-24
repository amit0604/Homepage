/**
 * Single shared LDAP service for login, Keycloak group lookup, chat directory, ticket import.
 * Initialized after deployment env is loaded (see app.js bootstrap order).
 */
const ActiveDirectoryService = require('./ldapService');

const instance = new ActiveDirectoryService();

module.exports = instance;

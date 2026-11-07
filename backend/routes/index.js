const express = require("express");
const userRoutes = require("./userRoutes");
const ticketRouter = require('./ticketRouter');
const notificationsRouter = require('./notificationsRouter');
const serverRouter = require('./serverRouter');
const departmentRouter = require('./departmentRouter');
const settingsRouter = require('./settingsRouter');
const uploadRouter = require('./uploadRouter');
const shortcutRouter = require('./shortcutRouter');
const checkmkRouter = require('./checkmkRouter');
const lobbyChatRouter = require('./lobbyChatRouter');
const chatRouter = require('./chatRouter');
const pingerRouter = require('./pingerRouter');
const keycloakRouter = require('./keycloakRouter');
const adminDataRouter = require('./adminDataRouter');

const router = express.Router();

router.use("", keycloakRouter);
router.use("", userRoutes);
router.use('', ticketRouter);
router.use('', notificationsRouter);
router.use("", serverRouter);
router.use("", departmentRouter);
router.use("", settingsRouter);
router.use("", uploadRouter);
router.use("", shortcutRouter);
router.use('', checkmkRouter);
router.use('', lobbyChatRouter);
router.use('', chatRouter);
router.use('', pingerRouter);
router.use('', adminDataRouter);
router.use('', require('./integrationRouter'));
router.use('', require('./notifyDevicesRouter'));

module.exports = router;
const express = require('express');
const { jwtMiddleware, isAdminMiddleware } = require('../middlewares/jwtMiddleware');
const { getDownHostsCached } = require('../utils/checkmkClient');
const { isCheckmkUiEnabledByDeploy } = require('../utils/checkmkUi');
const { logFailure } = require('../utils/failureLog');

const router = express.Router();

/** Admin: hosts in DOWN or UNREACH (proxied from Checkmk; credentials stay on server). */
router.get('/admin/checkmk/down-hosts', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  if (!isCheckmkUiEnabledByDeploy()) {
    return res.status(200).json({
      checkmkUiEnabled: false,
      configured: false,
      hosts: [],
      message:
        'Checkmk is disabled on this deployment. Set CHECKMK_UI=true (or unset) to enable; CHECKMK_UI=false hides it.',
    });
  }
  try {
    const data = await getDownHostsCached();
    res.json({ ...data, checkmkUiEnabled: true });
  } catch (err) {
    logFailure('checkmk.down_hosts', err, { path: req.path });
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    res.status(status).json({
      configured: true,
      hosts: [],
      error: err.message || 'Checkmk request failed',
    });
  }
});

module.exports = router;

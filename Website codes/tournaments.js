const express = require("express");
const router = express.Router();
const {
  createTournament,
  getTournaments,
  getTournamentById,
  getUserTournaments,
  updateTournament,
  deleteTournament,
  deleteRegistration,
  addApprovedPlayer,
  addApprovedPlayersBulk,
  rejectPlayerRegistration,
  registerForTournament,
  publishTournament,
  unpublishTournament,
  addCoHost,
  removeCoHost,
  addReferee,
  removeReferee,
  getUserRegistrationsForTournament,
  assignPartner,
  getTournamentSponsors,
  updateTournamentSponsors,
  getTournamentRegistrations,
  updateGroupStandings,
  updateGroupMatches,
  submitCategoryPoints,
} = require("../controllers/tournamentController");
const authMiddleware = require("../middleware/authMiddleware");
const { cacheMiddleware } = require("../middleware/cache");
const multer = require("multer");
const path = require("path");

// =======================
// Multer File Upload Setup
// =======================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/tournaments/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname.replace(/\s+/g, "_"));
  },
});

const upload = multer({ storage });

// =======================
// Tournament Routes
// =======================

// ✅ Public: Get all tournaments (cached for 60s)
router.get("/", cacheMiddleware(60), getTournaments);

// ✅ Protected: Get logged-in user's tournaments (user-scoped cache for 30s)
router.get(
  "/my-tournaments",
  authMiddleware(),
  cacheMiddleware(30, (req) => `GET:/api/tournaments/my-tournaments:u-${req.user._id}`),
  getUserTournaments,
);

// ✅ Public: Get single tournament by ID (cached for 60s)
router.get("/:id", cacheMiddleware(60), getTournamentById);

// ✅ Club Admin: Get registrations for a tournament (includes proofOfPayment)
router.get(
  "/:id/registrations",
  authMiddleware(["clubadmin"]),
  getTournamentRegistrations,
);

// ✅ Protected: Get user's registrations for a specific tournament
router.get("/:id/user-registrations", authMiddleware(["player"]), getUserRegistrationsForTournament);

// ✅ Create tournament (clubadmins only)
router.post(
  "/",
  authMiddleware(["clubadmin"]), // only clubadmins
  upload.fields([
    { name: "tournamentPicture", maxCount: 1 },
    { name: "paymentMethodsFiles", maxCount: 3 },
    { name: "guidelinePictures", maxCount: 10 },
    { name: "schedulePictures", maxCount: 3 },
  ]),
  createTournament,
);

// ✅ Edit tournament (only author can edit)
router.put(
  "/:id",
  authMiddleware(["clubadmin"]),
  upload.fields([
    { name: "tournamentPicture", maxCount: 1 },
    { name: "paymentMethodsFiles", maxCount: 3 },
    { name: "guidelinePictures", maxCount: 10 },
    { name: "schedulePictures", maxCount: 3 },
  ]),
  updateTournament,
);
// ✅ Register for tournament (players only)
router.post(
  "/register",
  authMiddleware(["player"]),
  upload.array("proofOfPayment", 2),
  registerForTournament,
);

// Delete Tournament
router.delete("/:id", authMiddleware(["clubadmin"]), deleteTournament);

// ✅ Add approved player to a tournament category
router.post(
  "/:id/registrations/approve",
  authMiddleware(),
  addApprovedPlayer,
);

// ✅ Bulk approve players for a tournament category (new form structure)
router.post(
  "/:id/registrations/approve-bulk",
  authMiddleware(),
  addApprovedPlayersBulk,
);


// ✅ Reject player registration
router.post(
  "/:id/registrations/reject",
  authMiddleware(),
  rejectPlayerRegistration,
);

// DELETE player registration
router.delete(
  "/:tournamentId/registrations/:registrationId",
  authMiddleware(["clubadmin"]),
  deleteRegistration,
);

// ✅ Publish tournament (only tournament creator)
router.put(
  "/:id/publish",
  authMiddleware(["clubadmin"]),
  publishTournament,
);

// ✅ Unpublish tournament (only tournament creator)
router.put(
  "/:id/unpublish",
  authMiddleware(["clubadmin"]),
  unpublishTournament,
);

// ✅ Add co-host to tournament (clubadmins only)
router.post(
  "/:id/add-cohost",
  authMiddleware(["clubadmin"]),
  addCoHost,
);

// ✅ Remove co-host from tournament (clubadmins only)
router.post(
  "/:id/remove-cohost",
  authMiddleware(["clubadmin"]),
  removeCoHost,
);

// ✅ Add referee to tournament (clubadmins only)
router.post(
  "/:id/add-referee",
  authMiddleware(["clubadmin"]),
  addReferee,
);

// ✅ Remove referee from tournament (clubadmins only)
router.post(
  "/:id/remove-referee",
  authMiddleware(["clubadmin"]),
  removeReferee,
);

// ✅ Protected: Assign partner to player registration
router.post(
  "/:id/registrations/assign-partner",
  authMiddleware(),
  assignPartner,
);

// =======================
// Sponsors Routes
// =======================

// ✅ Public: Get tournament sponsors (cached for 60s)
router.get(
  "/:id/sponsors",
  cacheMiddleware(60),
  getTournamentSponsors,
);

// ✅ Update tournament sponsors (creator/co-host)
router.put(
  "/:id/sponsors",
  authMiddleware(["clubadmin", "superadmin"]),
  updateTournamentSponsors,
);

// ✅ Update group standings (clubadmin/superadmin/referee)
router.put(
  "/:id/categories/:categoryId/groups/:groupId/standings",
  authMiddleware(["clubadmin", "superadmin", "referee"]),
  updateGroupStandings,
);

// ✅ Update group matches (clubadmin/superadmin/referee) and recompute standings
router.put(
  "/:id/categories/:categoryId/groups/:groupId/matches",
  authMiddleware(["clubadmin", "superadmin", "referee"]),
  updateGroupMatches,
);

// ✅ Submit points for a category (clubadmin/superadmin)
router.post(
  "/:id/categories/:categoryId/submit-points",
  authMiddleware(["clubadmin", "superadmin"]),
  submitCategoryPoints,
);

 module.exports = router;

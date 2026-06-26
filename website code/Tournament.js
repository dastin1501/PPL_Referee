const mongoose = require("mongoose");

const registrationSchema = new mongoose.Schema(
  {
    player: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    partner: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    partnerStatus: {
      type: String,
      enum: ["pending", "accepted", "declined"],
      default: "pending",
    },
    teamMembers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    category: { type: String, required: true },
    proofOfPayment: { type: [String], default: [] },
    contactNumber: { type: String },
    email: { type: String },
    // Additional registration fields
    playerName: { type: String },
    playerEmail: { type: String },
    playerPhone: { type: String },
    emergencyContact: { type: String },
    emergencyPhone: { type: String },
    shirtSize: { type: String, trim: true },
    paymentMode: { type: String, enum: ["manual", "paymongo"], default: "manual" },
    paymentStatus: {
      type: String,
      enum: ["pending", "awaiting_payment", "unpaid", "paid", "failed"],
      default: "pending",
    },
    paidAmount: { type: Number, default: 0 },
    paymongoCheckoutSessionId: { type: String, default: "" },
    paymongoPaymentIntentId: { type: String, default: "" },
    paymongoPaymentId: { type: String, default: "" },
    teamName: { type: String }, // Team name for team registrations
    notes: { type: String },
    registrationDate: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "reserved", "waiting", "awaiting_payment"],
      default: "pending",
    },
    waitlist: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const eventScoreSchema = new mongoose.Schema(
  {
    game1: {
      team1: { type: Number, default: 0 },
      team2: { type: Number, default: 0 },
    },
    game2: {
      team1: { type: Number, default: 0 },
      team2: { type: Number, default: 0 },
    },
    game3: {
      team1: { type: Number, default: 0 },
      team2: { type: Number, default: 0 },
    },
    final: {
      team1: { type: Number, default: 0 },
      team2: { type: Number, default: 0 },
    },
  },
  { _id: false }
);

// Match schema for elimination brackets
const matchSchema = new mongoose.Schema({
  id: { type: String, required: true },
  player1: { type: String, default: "TBD" },
  player2: { type: String, default: "TBD" },
  player1Id: { type: String, default: "" },
  player2Id: { type: String, default: "" },
  player1Name: { type: String, default: "" },
  player2Name: { type: String, default: "" },
  matchId: { type: String, default: "" },
  score1: { type: Number, default: 0 },
  score2: { type: Number, default: 0 },
  game1Player1: { type: Number, default: 0 },
  game1Player2: { type: Number, default: 0 },
  game2Player1: { type: Number, default: 0 },
  game2Player2: { type: Number, default: 0 },
  game3Player1: { type: Number, default: 0 },
  game3Player2: { type: Number, default: 0 },
  finalScorePlayer1: { type: Number, default: 0 },
  finalScorePlayer2: { type: Number, default: 0 },
  winner: { type: String, default: null },
  round: { type: String, required: true },
  // Persisted per-match status (e.g., 'Scheduled', 'Ongoing', 'Completed', 'Unschedule')
  status: { type: String, default: "" },
  court: { type: String, default: "" },
  date: { type: String, default: "" },
  time: { type: String, default: "" },
  refereeNumber: { type: String, default: "" },
  signatureData: { type: String, default: "" },
  refereeNote: { type: String, default: "" },
  refereeLocks: { type: [Boolean], default: [] },
  gameSignatures: { type: [String], default: [] },

  // Team divisions (MD/WD/XD) — only used for team categories
  team1Id: { type: mongoose.Schema.Types.ObjectId, default: null },
  team2Id: { type: mongoose.Schema.Types.ObjectId, default: null },
  mdPlayersTeam1: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  mdPlayersTeam2: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  wdPlayersTeam1: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  wdPlayersTeam2: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  xdPlayersTeam1: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  xdPlayersTeam2: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  mdScores: { type: eventScoreSchema, default: undefined },
  wdScores: { type: eventScoreSchema, default: undefined },
  xdScores: { type: eventScoreSchema, default: undefined },
  mdStatus: { type: String, default: undefined },
  wdStatus: { type: String, default: undefined },
  xdStatus: { type: String, default: undefined },

  // Per-game team member picks (team categories)
  game1Team1Player: { type: String, default: "" },
  game1Team1Player2: { type: String, default: "" },
  game1Team2Player: { type: String, default: "" },
  game1Team2Player2: { type: String, default: "" },
  game2Team1Player: { type: String, default: "" },
  game2Team1Player2: { type: String, default: "" },
  game2Team2Player: { type: String, default: "" },
  game2Team2Player2: { type: String, default: "" },
  game3Team1Player: { type: String, default: "" },
  game3Team1Player2: { type: String, default: "" },
  game3Team2Player: { type: String, default: "" },
  game3Team2Player2: { type: String, default: "" },
});

// Standing schema for group stage
const standingSchema = new mongoose.Schema({
  player: { type: String, required: true },
  teamId: { type: String, default: "" },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  pointsFor: { type: Number, default: 0 },
  pointsAgainst: { type: Number, default: 0 },
  pointDifferential: { type: Number, default: 0 },
  rankPoints: { type: Number, default: 0 },
});

// Group schema for group stage
const groupSchema = new mongoose.Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  standings: [standingSchema],
  matches: { type: mongoose.Schema.Types.Mixed, default: {} },
  originalPlayers: { type: [String], default: [] },
});

// Group stage schema
const groupStageSchema = new mongoose.Schema({
  groups: [groupSchema],
});

// Elimination matches schema
const eliminationMatchesSchema = new mongoose.Schema({
  matches: [matchSchema],
  status: {
    type: String,
    enum: ["Unscheduled", "Scheduled", "Ongoing", "Completed"],
    default: "Unscheduled",
  },
});

const tournamentCategorySchema = new mongoose.Schema({
  division: { type: String, required: true },
  ageCategory: { type: String },
  skillLevel: { type: String, required: true },
  maxParticipants: { type: Number, required: true },
  reservedSlots: { type: Number, default: 0 },
  setPartner: { type: Boolean, default: false },
  bracketMode: { type: Number, default: 4 }, // Number of brackets (1, 2, 4, 8)
  gamesPerMatch: { type: Number, default: 3, min: 1, max: 3 },
  scoringType: { type: String, enum: ["rally", "sideout"], default: "sideout" },
  groupStage: { type: groupStageSchema, default: null },
  eliminationMatches: { type: eliminationMatchesSchema, default: null },
  withShirt: { type: Boolean, default: false },
  fee: { type: Number, default: 0 },
  pairOverrides: { type: mongoose.Schema.Types.Mixed, default: null },
  pointsSubmitted: { type: Boolean, default: false },
  pointsSubmittedAt: { type: Date, default: null },
  locked: { type: Boolean, default: false },
  status: { type: String, enum: ["Open", "Closed"], default: "Open" },
});

const paymentMethodSchema = new mongoose.Schema({
  bankName: String,
  accountName: String,
  accountNumber: String,
  qrLink: { type: String, default: "" },
  qrCodeImage: { type: String, default: null }, // default null avoids empty object errors
});

// Sponsor schema for tournament sponsors
const sponsorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  logoUrl: { type: String, default: "" },
  link: { type: String, default: "" },
  description: { type: String, default: "" },
  // Category index (0-5 for six categories)
  categoryIndex: { type: Number, default: 0, min: 0 },
  // Optional slot position within a category (1-6)
  position: { type: Number, default: 1, min: 1 },
});

const tournamentSchema = new mongoose.Schema(
  {
    tournamentName: { type: String, required: true },
    // Optional fields displayed near the tournament name in the UI
    poweredBy: { type: String, default: "" },
    host: { type: String, default: "" },
    description: { type: String, required: true },
    tournamentPicture: { type: String },
    registrationInstructions: { type: String, required: true },
    registrationDeadline: { type: Date, required: true },
    registrationOpensAt: { type: Date },
    registrationClosesAt: { type: Date },
    tournamentDates: [{ type: Date, required: true }],
    category: { type: String, required: true },
    skillLevel: { type: String, required: true },
    // Registration gating based on DUPR entitlements (does not affect other logic)
    duprRequirement: {
      type: String,
      enum: ["OPEN", "VERIFIED_PLAYERS", "DUPR_PLUS"],
      default: "OPEN",
    },
    entryFeeMin: { type: Number },
    entryFeeMax: { type: Number },
    prizePool: { type: String },
    venueName: { type: String },
    venueAddress: { type: String },
    venueCity: { type: String },
    venueState: { type: String },
    venueZip: { type: String },
    contactEmail: { type: String, required: true },
    contactPhone: { type: String },
    rules: { type: String },
    events: { type: String },
    // Optional images shown under Guidelines & Events tab
    guidelinePictures: { type: [String], default: [] },
    // Optional images for Schedule section (formerly Events)
    schedulePictures: { type: [String], default: [] },
    // Court assignment grid saved from Schedule tab (time slots + per-court placements)
    courtAssignments: { type: mongoose.Schema.Types.Mixed, default: null },
    courtAssignmentsByDate: { type: mongoose.Schema.Types.Mixed, default: {} },
    migratedCourtAssignments: { type: Boolean, default: false },
    paymentMethods: {
      type: [paymentMethodSchema],
      validate: [
        (val) => val.length <= 3,
        "Only up to 3 payment methods allowed",
      ],
    },
    additionalInfo: { type: String },
    tournamentCategories: [tournamentCategorySchema],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    coHosts: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    referees: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    status: {
      type: String,
      enum: ["Upcoming", "Ongoing", "Completed"],
      default: "Upcoming",
    },
    published: {
      type: Boolean,
      default: false,
    },

    // ✅ Add registrations here
    registrations: [registrationSchema],

    // ✅ Sponsors visible across devices
    sponsors: [sponsorSchema],
    // ✅ Sponsor categories: support objects { name, size } while remaining backward-compatible
    sponsorCategories: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { timestamps: true },
);

// Indexes for faster lookups
tournamentSchema.index({ createdAt: -1 });
tournamentSchema.index({ published: 1, status: 1 });
tournamentSchema.index({ createdBy: 1 });
tournamentSchema.index({ coHosts: 1 });
tournamentSchema.index({ registrationDeadline: 1 });
tournamentSchema.index({ registrationOpensAt: 1 });
tournamentSchema.index({ registrationClosesAt: 1 });
tournamentSchema.index({ category: 1, skillLevel: 1 });
// Index nested registration player for user-centric queries
tournamentSchema.index({ 'registrations.player': 1 });
tournamentSchema.index({ 'tournamentCategories.groupStage.groups.standings.player': 1 });
tournamentSchema.index({ 'tournamentCategories.groupStage.groups.standings.rankPoints': -1 });
tournamentSchema.index({ 'tournamentCategories.eliminationMatches.matches.status': 1 });
tournamentSchema.index({ 'tournamentCategories.eliminationMatches.status': 1 });

module.exports = mongoose.model("Tournament", tournamentSchema);

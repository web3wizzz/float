// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IAgentAuth} from "./interfaces/IAgentAuth.sol";
import {IInvoiceEscrow} from "./interfaces/IInvoiceEscrow.sol";
import {InvoiceTypes} from "./libraries/InvoiceTypes.sol";

/// @title AgentVault
/// @notice Float vault. The owner funds tUSD8 and writes a policy. An agent spends
///         only inside that policy: per-tx cap, rolling 24h cap, expiry, allowlist,
///         pause, and revoke. Recurring schedules are keeper-executed and still
///         pass the same checks. Tagline: give your agents a float, not your keys.
contract AgentVault is EIP712, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_BATCH = 8;
    uint256 public constant BUCKETS = 24;
    uint64 public constant MIN_INTERVAL = 1 hours;

    bytes32 public constant PAYMENT_INTENT_TYPEHASH = keccak256(
        "PaymentIntent(address agent,address payee,uint256 amount,bytes32 memo,uint256 nonce,uint256 deadline)"
    );

    struct Policy {
        uint128 perTxLimit;
        uint128 dailyLimit;
        uint64 expiry;
        bool allowAnyPayee;
        bool paused;
        bool active;
    }

    struct PaymentIntent {
        address agent;
        address payee;
        uint256 amount;
        bytes32 memo;
        uint256 nonce;
        uint256 deadline;
    }

    /// @notice One row per clock-hour. A bucket counts while `nowHour < bucketHour + 24`.
    struct Rolling {
        uint128[24] buckets;
        uint64[24] bucketHour;
    }

    struct Schedule {
        address agent;
        address payee;
        uint128 amount;
        uint64 interval;
        uint64 nextRun;
        uint32 maxRuns;
        uint32 runs;
        bool active;
        bytes32 memo;
    }

    IERC20 public immutable token;
    IAgentAuth public auth;
    address public escrow;

    bool public globalPaused;
    /// @dev Token units locked for remaining schedule runs. Discretionary spends cannot touch this.
    uint256 public reserved;

    mapping(address agent => Policy) public policies;
    mapping(address agent => mapping(address payee => bool)) public allowedPayee;
    mapping(address agent => uint256) public nonces;
    mapping(uint256 id => Schedule) public schedules;
    uint256 public scheduleCount;
    /// @dev Sum of remaining obligation on schedules the agent itself opened.
    ///      Owner-opened schedules do not count, so the owner can still fund rent.
    mapping(address agent => uint256) public agentReserved;
    mapping(uint256 id => bool) public scheduleFromAgent;

    mapping(address agent => Rolling) private rolling;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event AgentRegistered(
        address indexed agent, uint128 perTxLimit, uint128 dailyLimit, uint64 expiry, bool allowAnyPayee
    );
    event AgentRevoked(address indexed agent);
    event AgentPaused(address indexed agent, bool paused);
    event GlobalPaused(bool paused);
    event PayeeUpdated(address indexed agent, address indexed payee, bool allowed);
    event PolicyUpdated(
        address indexed agent, uint128 perTxLimit, uint128 dailyLimit, uint64 expiry, bool allowAnyPayee
    );
    event AgentPaid(address indexed agent, address indexed payee, uint256 amount, bytes32 memo, address indexed caller);
    event OwnerPaid(address indexed payee, uint256 amount, bytes32 memo);
    event EscrowFunded(address indexed agent, uint256 indexed invoiceId, address payee, uint256 amount);
    event AuthUpdated(address indexed auth);
    event EscrowUpdated(address indexed escrow);
    event ScheduleCreated(
        uint256 indexed id,
        address indexed agent,
        address indexed payee,
        uint128 amount,
        uint64 interval,
        uint32 maxRuns
    );
    event ScheduleExecuted(uint256 indexed id, uint32 runs, uint64 nextRun);
    event ScheduleCancelled(uint256 indexed id, uint256 releasedReserve);

    error ZeroAddress();
    error ZeroAmount();
    error PerTxExceedsDaily();
    error AgentNotActive(address agent);
    error AgentIsPaused(address agent);
    error AgentExpired(address agent, uint64 expiry);
    error GloballyPaused();
    error PerTxLimitExceeded(address agent, uint256 amount, uint256 limit);
    error DailyLimitExceeded(address agent, uint256 spent, uint256 amount, uint256 limit);
    error PayeeNotAllowed(address agent, address payee);
    error InsufficientAvailable(uint256 available, uint256 amount);
    error InsufficientReserve(uint256 balance, uint256 needed);
    error BelowReserve(uint256 balance, uint256 reservedFunds, uint256 amount);
    error EscrowNotSet();
    error NotInvoicePayer();
    error InvoiceNotOpen();
    error BadBatch();
    error IntentExpired();
    error BadNonce(uint256 expected, uint256 provided);
    error InvalidSignature();
    error NotScheduleParty();
    error ScheduleInactive(uint256 id);
    error ScheduleExhausted(uint256 id);
    error NotDue(uint256 id, uint64 nextRun);
    error IntervalTooShort(uint64 min, uint64 given);
    error UnknownSchedule(uint256 id);
    error AgentReserveCap(uint256 obligation, uint256 dailyLimit);
    error MaxRunsZero();

    constructor(IERC20 paymentToken, address initialOwner, IAgentAuth agentAuth)
        EIP712("Float Vault", "1")
        Ownable(initialOwner)
    {
        if (address(paymentToken) == address(0) || address(agentAuth) == address(0)) {
            revert ZeroAddress();
        }
        token = paymentToken;
        auth = agentAuth;
    }

    function setAuth(IAgentAuth next) external onlyOwner {
        if (address(next) == address(0)) revert ZeroAddress();
        auth = next;
        emit AuthUpdated(address(next));
    }

    function setEscrow(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        escrow = next;
        emit EscrowUpdated(next);
    }

    function deposit(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = token.balanceOf(address(this));
        if (amount > bal || bal - amount < reserved) revert BelowReserve(bal, reserved, amount);
        token.safeTransfer(owner(), amount);
        emit Withdrawn(owner(), amount);
    }

    function registerAgent(address agent, uint128 perTxLimit, uint128 dailyLimit, uint64 expiry, bool allowAnyPayee)
        external
        onlyOwner
    {
        if (agent == address(0)) revert ZeroAddress();
        if (perTxLimit == 0 || dailyLimit == 0) revert ZeroAmount();
        if (perTxLimit > dailyLimit) revert PerTxExceedsDaily();
        policies[agent] = Policy({
            perTxLimit: perTxLimit,
            dailyLimit: dailyLimit,
            expiry: expiry,
            allowAnyPayee: allowAnyPayee,
            paused: false,
            active: true
        });
        delete rolling[agent];
        emit AgentRegistered(agent, perTxLimit, dailyLimit, expiry, allowAnyPayee);
    }

    function updatePolicy(address agent, uint128 perTxLimit, uint128 dailyLimit, uint64 expiry, bool allowAnyPayee)
        external
        onlyOwner
    {
        if (!policies[agent].active) revert AgentNotActive(agent);
        if (perTxLimit == 0 || dailyLimit == 0) revert ZeroAmount();
        if (perTxLimit > dailyLimit) revert PerTxExceedsDaily();
        Policy storage p = policies[agent];
        p.perTxLimit = perTxLimit;
        p.dailyLimit = dailyLimit;
        p.expiry = expiry;
        p.allowAnyPayee = allowAnyPayee;
        emit PolicyUpdated(agent, perTxLimit, dailyLimit, expiry, allowAnyPayee);
    }

    function setPayee(address agent, address payee, bool allowed) external onlyOwner {
        if (!policies[agent].active) revert AgentNotActive(agent);
        if (payee == address(0)) revert ZeroAddress();
        allowedPayee[agent][payee] = allowed;
        emit PayeeUpdated(agent, payee, allowed);
    }

    function setAgentPaused(address agent, bool paused) external onlyOwner {
        if (!policies[agent].active) revert AgentNotActive(agent);
        policies[agent].paused = paused;
        emit AgentPaused(agent, paused);
    }

    function revokeAgent(address agent) external onlyOwner {
        if (!policies[agent].active) revert AgentNotActive(agent);
        policies[agent].active = false;
        emit AgentRevoked(agent);
    }

    function setGlobalPaused(bool paused) external onlyOwner {
        globalPaused = paused;
        emit GlobalPaused(paused);
    }

    function pay(address payee, uint256 amount, bytes32 memo) external nonReentrant {
        _spend(msg.sender, payee, amount, memo, false);
    }

    /// @notice The owner spends their own float. Agent limits do not apply. Reserved funds stay locked.
    function payAsOwner(address payee, uint256 amount, bytes32 memo) external onlyOwner nonReentrant {
        if (globalPaused) revert GloballyPaused();
        if (payee == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 available = _available();
        if (amount > available) revert InsufficientAvailable(available, amount);
        token.safeTransfer(payee, amount);
        emit OwnerPaid(payee, amount, memo);
    }

    function batchPay(address[] calldata payees, uint256[] calldata amounts, bytes32[] calldata memos)
        external
        nonReentrant
    {
        uint256 n = payees.length;
        if (n == 0 || n > MAX_BATCH || amounts.length != n || memos.length != n) revert BadBatch();
        for (uint256 i; i < n;) {
            _spend(msg.sender, payees[i], amounts[i], memos[i], false);
            unchecked {
                ++i;
            }
        }
    }

    function executeIntent(PaymentIntent calldata intent, bytes calldata signature) external nonReentrant {
        if (block.timestamp > intent.deadline) revert IntentExpired();
        if (intent.nonce != nonces[intent.agent]) revert BadNonce(nonces[intent.agent], intent.nonce);
        bytes32 digest = hashIntent(intent);
        if (!auth.verify(intent.agent, digest, signature)) revert InvalidSignature();
        nonces[intent.agent] = intent.nonce + 1;
        _spend(intent.agent, intent.payee, intent.amount, intent.memo, false);
    }

    function fundInvoice(uint256 invoiceId) external nonReentrant {
        if (escrow == address(0)) revert EscrowNotSet();
        (address payee, address payer, uint256 amount,,,,, InvoiceTypes.Status status) =
            IInvoiceEscrow(escrow).invoices(invoiceId);
        if (payer != address(this)) revert NotInvoicePayer();
        if (status != InvoiceTypes.Status.Open) revert InvoiceNotOpen();
        _enforce(msg.sender, payee, amount);
        uint256 available = _available();
        if (amount > available) revert InsufficientAvailable(available, amount);
        token.forceApprove(escrow, amount);
        IInvoiceEscrow(escrow).fund(invoiceId);
        token.forceApprove(escrow, 0);
        emit EscrowFunded(msg.sender, invoiceId, payee, amount);
    }

    function confirmInvoice(uint256 invoiceId) external onlyOwner {
        if (escrow == address(0)) revert EscrowNotSet();
        IInvoiceEscrow(escrow).confirm(invoiceId);
    }

    function refundInvoice(uint256 invoiceId) external onlyOwner {
        if (escrow == address(0)) revert EscrowNotSet();
        IInvoiceEscrow(escrow).refund(invoiceId);
    }

    function disputeInvoice(uint256 invoiceId) external onlyOwner {
        if (escrow == address(0)) revert EscrowNotSet();
        IInvoiceEscrow(escrow).dispute(invoiceId);
    }

    /// @notice Owner, or the agent, opens a schedule. Missed intervals are not caught up:
    ///         `executeSchedule` pays once and sets the next run to now + interval.
    /// @dev The sum of schedules an agent opens cannot reserve more than that agent's
    ///      daily limit, so a hot key cannot lock the vault by opening many of them.
    ///      A paused or globally paused agent cannot open one. An already-expired
    ///      agent cannot either: the runs could never execute.
    function createSchedule(address agent, address payee, uint128 amount, uint64 interval, uint32 maxRuns, bytes32 memo)
        external
        returns (uint256 id)
    {
        if (msg.sender != owner() && msg.sender != agent) revert NotScheduleParty();
        if (!policies[agent].active) revert AgentNotActive(agent);
        if (payee == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (maxRuns == 0) revert MaxRunsZero();
        if (interval < MIN_INTERVAL) revert IntervalTooShort(MIN_INTERVAL, interval);
        Policy storage p = policies[agent];
        if (p.expiry != 0 && block.timestamp > p.expiry) revert AgentExpired(agent, p.expiry);
        if (amount > p.perTxLimit) revert PerTxLimitExceeded(agent, amount, p.perTxLimit);
        if (!p.allowAnyPayee && !allowedPayee[agent][payee]) revert PayeeNotAllowed(agent, payee);
        uint256 obligation = uint256(amount) * uint256(maxRuns);
        bool fromAgent = msg.sender == agent;
        if (fromAgent) {
            if (globalPaused) revert GloballyPaused();
            if (p.paused) revert AgentIsPaused(agent);
            uint256 nextReserved = agentReserved[agent] + obligation;
            if (nextReserved > p.dailyLimit) revert AgentReserveCap(nextReserved, p.dailyLimit);
        }
        uint256 bal = token.balanceOf(address(this));
        if (obligation > bal || reserved > bal - obligation) revert InsufficientReserve(bal, reserved + obligation);
        reserved += obligation;
        id = ++scheduleCount;
        if (fromAgent) {
            agentReserved[agent] += obligation;
            scheduleFromAgent[id] = true;
        }
        schedules[id] = Schedule({
            agent: agent,
            payee: payee,
            amount: amount,
            interval: interval,
            nextRun: uint64(block.timestamp),
            maxRuns: maxRuns,
            runs: 0,
            active: true,
            memo: memo
        });
        emit ScheduleCreated(id, agent, payee, amount, interval, maxRuns);
    }

    function cancelSchedule(uint256 id) external nonReentrant {
        Schedule storage s = schedules[id];
        if (s.agent == address(0)) revert UnknownSchedule(id);
        if (msg.sender != owner() && msg.sender != s.agent) revert NotScheduleParty();
        if (!s.active) revert ScheduleInactive(id);
        uint256 remaining = uint256(s.amount) * uint256(s.maxRuns - s.runs);
        s.active = false;
        reserved -= remaining;
        if (scheduleFromAgent[id]) agentReserved[s.agent] -= remaining;
        emit ScheduleCancelled(id, remaining);
    }

    function executeSchedule(uint256 id) external nonReentrant {
        Schedule storage s = schedules[id];
        if (s.agent == address(0)) revert UnknownSchedule(id);
        if (!s.active) revert ScheduleInactive(id);
        if (s.runs >= s.maxRuns) revert ScheduleExhausted(id);
        if (block.timestamp < s.nextRun) revert NotDue(id, s.nextRun);
        // One payment for the whole gap since `nextRun`. Bookkeeping moves first so a
        // token callback cannot observe a schedule that is still due, and the next run
        // is `now + interval` rather than one charge per missed interval.
        uint256 amount = s.amount;
        address schedAgent = s.agent;
        address payee = s.payee;
        bytes32 memo = s.memo;
        s.runs += 1;
        s.nextRun = uint64(block.timestamp) + s.interval;
        if (s.runs >= s.maxRuns) s.active = false;
        if (scheduleFromAgent[id]) agentReserved[schedAgent] -= amount;
        _spend(schedAgent, payee, amount, memo, true);
        emit ScheduleExecuted(id, s.runs, s.nextRun);
    }

    function hashIntent(PaymentIntent calldata intent) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                PAYMENT_INTENT_TYPEHASH,
                intent.agent,
                intent.payee,
                intent.amount,
                intent.memo,
                intent.nonce,
                intent.deadline
            )
        );
        return _hashTypedDataV4(structHash);
    }

    function spentInWindow(address agent) public view returns (uint256 spent) {
        Rolling storage r = rolling[agent];
        uint64 hour = uint64(block.timestamp / 1 hours);
        for (uint256 i; i < BUCKETS;) {
            if (r.buckets[i] != 0 && hour < r.bucketHour[i] + BUCKETS) {
                spent += r.buckets[i];
            }
            unchecked {
                ++i;
            }
        }
    }

    function availableBalance() public view returns (uint256) {
        return _available();
    }

    function _available() internal view returns (uint256) {
        uint256 bal = token.balanceOf(address(this));
        return bal > reserved ? bal - reserved : 0;
    }

    function _enforce(address agent, address payee, uint256 amount) internal {
        Policy storage p = policies[agent];
        if (globalPaused) revert GloballyPaused();
        if (!p.active) revert AgentNotActive(agent);
        if (p.paused) revert AgentIsPaused(agent);
        if (p.expiry != 0 && block.timestamp > p.expiry) revert AgentExpired(agent, p.expiry);
        if (amount == 0) revert ZeroAmount();
        if (payee == address(0)) revert ZeroAddress();
        if (amount > p.perTxLimit) revert PerTxLimitExceeded(agent, amount, p.perTxLimit);
        if (!p.allowAnyPayee && !allowedPayee[agent][payee]) revert PayeeNotAllowed(agent, payee);
        uint256 spent = spentInWindow(agent);
        if (spent + amount > p.dailyLimit) revert DailyLimitExceeded(agent, spent, amount, p.dailyLimit);
        Rolling storage r = rolling[agent];
        uint64 hour = uint64(block.timestamp / 1 hours);
        uint256 idx = uint256(hour % BUCKETS);
        if (r.bucketHour[idx] != hour) {
            r.buckets[idx] = 0;
            r.bucketHour[idx] = hour;
        }
        r.buckets[idx] += uint128(amount);
    }

    function _spend(address agent, address payee, uint256 amount, bytes32 memo, bool fromReserve) internal {
        _enforce(agent, payee, amount);
        if (fromReserve) {
            reserved -= amount;
        } else {
            uint256 available = _available();
            if (amount > available) revert InsufficientAvailable(available, amount);
        }
        token.safeTransfer(payee, amount);
        emit AgentPaid(agent, payee, amount, memo, msg.sender);
    }
}

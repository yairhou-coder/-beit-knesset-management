/**
 * כרטיס חבר הקהילה (סעיף 24).
 * מרכז את כל הפעילות הכספית של החבר: התחייבויות, תשלומים, הכנסות,
 * קבלות שהופקו עבורו והוראות קבע - בהפרדה לפי עמותה.
 */

import type { Db } from '../db/index.js';
import { listCommitments, type CommitmentView } from './commitments.js';
import { listIncomes, type IncomeView } from './incomes.js';
import { getMember, type MemberView } from './members.js';
import { listPayments, type PaymentView } from './payments.js';
import { listReceipts, type ReceiptView } from './receipts.js';
import { listStandingOrders, type StandingOrderView } from './standingOrders.js';
import { daysSince } from './util.js';

export interface MemberBalanceByOrganization {
  organization: { id: number; name: string };
  committedAgorot: number;
  paidAgorot: number;
  outstandingAgorot: number;
  openCommitments: number;
  oldestDebtDays: number;
}

export interface MemberCard {
  member: MemberView;
  totals: {
    committedAgorot: number;
    paidAgorot: number;
    outstandingAgorot: number;
    openCommitments: number;
    receiptsIssued: number;
  };
  balancesByOrganization: MemberBalanceByOrganization[];
  commitments: CommitmentView[];
  payments: PaymentView[];
  incomes: IncomeView[];
  /** כל הקבלות שהופקו עבור החבר (סעיף 24). */
  receipts: ReceiptView[];
  standingOrders: StandingOrderView[];
}

export function getMemberCard(
  db: Db,
  memberId: number,
  options: { organizationId?: number; limit?: number } = {},
): MemberCard {
  const member = getMember(db, memberId);
  const limit = options.limit ?? 200;
  const orgFilter = options.organizationId ? { organizationId: options.organizationId } : {};

  const balanceRows = db
    .prepare(
      `SELECT c.organization_id, o.name AS organization_name,
              SUM(CASE WHEN c.status != 'cancelled' THEN c.amount_agorot ELSE 0 END) AS committed,
              SUM(CASE WHEN c.status != 'cancelled' THEN c.paid_agorot ELSE 0 END) AS paid,
              COALESCE(SUM(CASE WHEN c.status IN ('open','partially_paid') THEN c.balance_agorot END), 0) AS outstanding,
              SUM(CASE WHEN c.status IN ('open','partially_paid') THEN 1 ELSE 0 END) AS open_count,
              MIN(CASE WHEN c.status IN ('open','partially_paid') THEN c.commitment_date END) AS oldest
       FROM commitments c
       JOIN organizations o ON o.id = c.organization_id
       WHERE c.member_id = ? ${options.organizationId ? 'AND c.organization_id = ?' : ''}
       GROUP BY c.organization_id, o.name
       ORDER BY outstanding DESC, o.name`,
    )
    .all(...(options.organizationId ? [memberId, options.organizationId] : [memberId])) as Array<{
    organization_id: number;
    organization_name: string;
    committed: number;
    paid: number;
    outstanding: number;
    open_count: number;
    oldest: string | null;
  }>;

  const balancesByOrganization: MemberBalanceByOrganization[] = balanceRows.map((row) => ({
    organization: { id: row.organization_id, name: row.organization_name },
    committedAgorot: row.committed,
    paidAgorot: row.paid,
    outstandingAgorot: row.outstanding,
    openCommitments: row.open_count,
    oldestDebtDays: row.oldest ? daysSince(row.oldest) : 0,
  }));

  const receipts = listReceipts(db, { memberId, ...orgFilter, limit });

  return {
    member,
    totals: {
      committedAgorot: balancesByOrganization.reduce((sum, row) => sum + row.committedAgorot, 0),
      paidAgorot: balancesByOrganization.reduce((sum, row) => sum + row.paidAgorot, 0),
      outstandingAgorot: balancesByOrganization.reduce((sum, row) => sum + row.outstandingAgorot, 0),
      openCommitments: balancesByOrganization.reduce((sum, row) => sum + row.openCommitments, 0),
      receiptsIssued: receipts.filter((receipt) => receipt.status === 'issued').length,
    },
    balancesByOrganization,
    commitments: listCommitments(db, { memberId, ...orgFilter, limit }),
    payments: listPayments(db, { memberId, ...orgFilter, limit }),
    incomes: listIncomes(db, { memberId, ...orgFilter, limit }),
    receipts,
    standingOrders: listStandingOrders(db, { memberId, ...orgFilter }),
  };
}

const cds = require('@sap/cds');
const { randomUUID } = require('node:crypto');

const { SELECT, INSERT, UPDATE } = cds.ql;
const LOG = cds.log('shipped-overlay');

// ---------------------------------------------------------------------------
// Shipped curated tcode -> Fiori app overlay. Boot-upserted per the
// sap-backend.md Shipped/Seed Content rule: keyed on MappingKey with an
// integer Revision for upgrade-in-place, wrapped in try/catch so a seed
// failure never blocks startup. No CSVs.
//
// CONTENT STATUS: a starter set covering the most common GUI transactions.
// EditorialConfidence HIGH marks app IDs the team has verified; MEDIUM rows
// carry the right app NAME but the F-number must be confirmed against the
// SAP Fiori Apps Reference Library for the customer's release before a
// proposal built on them is activated (the licensing position on bulk
// deriving library content is a flagged legal question - see the plan).
// Expanding this set is ongoing product-content work.
// ---------------------------------------------------------------------------

const REVISION = 1;

// [tcode, fioriId, title, type, coverage%, persona, LoB, businessRole, editorial, rationale]
const SHIPPED_MAPPINGS = [
  // --- Sales (SD) ---
  ['VA01', 'F3893', 'Manage Sales Orders - Version 2', 'REPLACES', 90, 'Sales Clerk', 'SD', 'SAP_BR_INTERNAL_SALES_REP', 'MEDIUM', 'Create flows of VA01 are covered end-to-end; special order types may vary.'],
  ['VA02', 'F3893', 'Manage Sales Orders - Version 2', 'REPLACES', 90, 'Sales Clerk', 'SD', 'SAP_BR_INTERNAL_SALES_REP', 'MEDIUM', 'Change flows of VA02 including mass status handling.'],
  ['VA03', 'F3893', 'Manage Sales Orders - Version 2', 'REPLACES', 95, 'Sales Clerk', 'SD', 'SAP_BR_INTERNAL_SALES_REP', 'MEDIUM', 'Display and list use of VA03 is fully covered.'],
  ['VA05', 'F1873', 'Sales Order Fulfillment - Analyze Issues', 'PARTIAL', 60, 'Sales Manager', 'SD', 'SAP_BR_INTERNAL_SALES_REP', 'MEDIUM', 'List-of-orders reporting; complex variants stay in GUI.'],
  ['VL02N', 'F0867A', 'Manage Outbound Deliveries', 'REPLACES', 85, 'Shipping Specialist', 'LE', 'SAP_BR_SHIPPING_SPECIALIST', 'MEDIUM', 'Delivery processing incl. picking and goods issue.'],
  ['VF01', 'F0797', 'Manage Billing Documents', 'REPLACES', 85, 'Billing Clerk', 'SD', 'SAP_BR_BILLING_CLERK', 'MEDIUM', 'Billing creation incl. billing due list.'],
  ['VF03', 'F0797', 'Manage Billing Documents', 'REPLACES', 90, 'Billing Clerk', 'SD', 'SAP_BR_BILLING_CLERK', 'MEDIUM', 'Billing display and PDF preview.'],
  // --- Procurement (MM-PUR) ---
  ['ME21N', 'F0842A', 'Manage Purchase Orders', 'REPLACES', 90, 'Purchaser', 'MM', 'SAP_BR_PURCHASER', 'HIGH', 'PO creation incl. item categories and delivery schedules.'],
  ['ME22N', 'F0842A', 'Manage Purchase Orders', 'REPLACES', 90, 'Purchaser', 'MM', 'SAP_BR_PURCHASER', 'HIGH', 'PO change flows.'],
  ['ME23N', 'F0842A', 'Manage Purchase Orders', 'REPLACES', 95, 'Purchaser', 'MM', 'SAP_BR_PURCHASER', 'HIGH', 'PO display.'],
  ['ME51N', 'F1643', 'Manage Purchase Requisitions - Professional', 'REPLACES', 85, 'Purchaser', 'MM', 'SAP_BR_PURCHASER', 'MEDIUM', 'PR creation; release strategies surface in-app.'],
  ['ME52N', 'F1643', 'Manage Purchase Requisitions - Professional', 'REPLACES', 85, 'Purchaser', 'MM', 'SAP_BR_PURCHASER', 'MEDIUM', 'PR change.'],
  ['ME2M', 'F2358', 'Purchase Order Items by Material (query)', 'PARTIAL', 60, 'Purchaser', 'MM', 'SAP_BR_PURCHASER', 'MEDIUM', 'Reporting slice of ME2M.'],
  // --- Inventory (MM-IM) ---
  ['MIGO', 'F0843', 'Post Goods Movement', 'PARTIAL', 70, 'Warehouse Clerk', 'MM', 'SAP_BR_INVENTORY_MANAGER', 'MEDIUM', 'Common movement types; specialised MIGO variants stay in GUI.'],
  ['MMBE', 'F1076', 'Stock - Single Material', 'REPLACES', 90, 'Warehouse Clerk', 'MM', 'SAP_BR_INVENTORY_MANAGER', 'MEDIUM', 'Stock overview per material/plant.'],
  ['MB52', 'F1595', 'Warehouse Stocks', 'REPLACES', 85, 'Warehouse Clerk', 'MM', 'SAP_BR_INVENTORY_MANAGER', 'MEDIUM', 'Warehouse stock listing.'],
  ['MIRO', 'F0859', 'Create Supplier Invoice', 'REPLACES', 85, 'AP Accountant', 'MM', 'SAP_BR_AP_ACCOUNTANT', 'HIGH', 'Invoice entry incl. PO reference; complex multi-account cases may remain.'],
  // --- Finance (FI) ---
  ['FB01', 'F0718', 'Post General Journal Entries', 'PARTIAL', 70, 'GL Accountant', 'FI', 'SAP_BR_GL_ACCOUNTANT', 'HIGH', 'General postings; special document types vary.'],
  ['FB50', 'F0718', 'Post General Journal Entries', 'REPLACES', 90, 'GL Accountant', 'FI', 'SAP_BR_GL_ACCOUNTANT', 'HIGH', 'G/L postings map one-to-one.'],
  ['FB03', 'F0717', 'Manage Journal Entries', 'REPLACES', 90, 'GL Accountant', 'FI', 'SAP_BR_GL_ACCOUNTANT', 'HIGH', 'Document display with line-item drill-down.'],
  ['FBL3N', 'F0706', 'Manage G/L Account Line Items', 'REPLACES', 90, 'GL Accountant', 'FI', 'SAP_BR_GL_ACCOUNTANT', 'MEDIUM', 'Line-item browsing with layouts.'],
  ['FBL1N', 'F0712', 'Manage Supplier Line Items', 'REPLACES', 90, 'AP Accountant', 'FI', 'SAP_BR_AP_ACCOUNTANT', 'HIGH', 'Supplier line items incl. clearing status.'],
  ['FBL5N', 'F0711', 'Manage Customer Line Items', 'REPLACES', 90, 'AR Accountant', 'FI', 'SAP_BR_AR_ACCOUNTANT', 'HIGH', 'Customer line items incl. dunning data.'],
  ['F-28', 'F1345', 'Post Incoming Payments', 'REPLACES', 85, 'AR Accountant', 'FI', 'SAP_BR_AR_ACCOUNTANT', 'MEDIUM', 'Payment entry with open-item clearing.'],
  ['F110', 'F0770', 'Manage Automatic Payments', 'REPLACES', 85, 'AP Accountant', 'FI', 'SAP_BR_AP_ACCOUNTANT', 'MEDIUM', 'Payment run parameters, proposal and execution.'],
  ['FK10N', 'F0712', 'Manage Supplier Line Items', 'PARTIAL', 60, 'AP Accountant', 'FI', 'SAP_BR_AP_ACCOUNTANT', 'MEDIUM', 'Balance view is a slice of the line-item app.'],
  // --- Controlling (CO) ---
  ['KSB1', 'F1671', 'Cost Centers - Actuals (query)', 'REPLACES', 80, 'Cost Accountant', 'CO', 'SAP_BR_OVERHEAD_ACCOUNTANT', 'MEDIUM', 'Cost-center actual line items.'],
  ['KS01', 'F1443A', 'Manage Cost Centers', 'REPLACES', 90, 'Cost Accountant', 'CO', 'SAP_BR_OVERHEAD_ACCOUNTANT', 'MEDIUM', 'Master data maintenance.'],
  // --- Production (PP) ---
  ['MD04', 'F2101', 'Monitor Material Coverage', 'PARTIAL', 70, 'Production Planner', 'PP', 'SAP_BR_PRODN_PLNR', 'MEDIUM', 'Stock/requirements monitoring; interactive pegging differs.'],
  ['MD01', 'F1339', 'Schedule MRP Runs', 'REPLACES', 85, 'Production Planner', 'PP', 'SAP_BR_PRODN_PLNR', 'MEDIUM', 'MRP run scheduling replaces the manual trigger.'],
  ['CO01', 'F2336', 'Manage Production Orders', 'PARTIAL', 70, 'Production Supervisor', 'PP', 'SAP_BR_PRODN_SUPERVISOR', 'MEDIUM', 'Order creation for standard scenarios.'],
  ['CO02', 'F2336', 'Manage Production Orders', 'PARTIAL', 70, 'Production Supervisor', 'PP', 'SAP_BR_PRODN_SUPERVISOR', 'MEDIUM', 'Order changes incl. operations.'],
  // --- Quality (QM) ---
  ['QA32', 'F2345', 'Manage Usage Decisions', 'REPLACES', 85, 'Quality Engineer', 'QM', 'SAP_BR_QUALITY_ENGINEER', 'MEDIUM', 'Inspection lot usage decisions.'],
  ['QE51N', 'F3319', 'Record Inspection Results', 'REPLACES', 85, 'Quality Technician', 'QM', 'SAP_BR_QUALITY_TECHNICIAN', 'MEDIUM', 'Results recording worklist.'],
  // --- Maintenance (PM) ---
  ['IW21', 'F4513', 'Create Maintenance Request', 'REPLACES', 85, 'Maintenance Technician', 'PM', 'SAP_BR_MAINTENANCE_TECHNICIAN', 'MEDIUM', 'Notification creation.'],
  ['IW31', 'F5123', 'Manage Maintenance Orders', 'PARTIAL', 70, 'Maintenance Planner', 'PM', 'SAP_BR_MAINTENANCE_PLANNER', 'MEDIUM', 'Order creation and planning.'],
  // --- Cross / Basis: deliberate NO_EQUIVALENT entries so the analysis can
  //     say "this usage has no Fiori path" instead of staying silent. ---
  ['SE16', '', 'No Fiori equivalent (data browser)', 'NO_EQUIVALENT', 0, 'IT', 'BC', '', 'HIGH', 'Developer/data-browser usage has no business-app equivalent; address via governance, not activation.'],
  ['SE38', '', 'No Fiori equivalent (ABAP editor)', 'NO_EQUIVALENT', 0, 'IT', 'BC', '', 'HIGH', 'Development tooling stays in ADT/GUI.'],
  ['SM37', 'F1758', 'Application Jobs (monitor)', 'PARTIAL', 50, 'IT Operator', 'BC', 'SAP_BR_ADMINISTRATOR', 'MEDIUM', 'Application-job monitoring covers business jobs; technical jobs stay in SM37.'],
  ['SU01', 'F1492', 'Maintain Business Users', 'PARTIAL', 60, 'User Administrator', 'BC', 'SAP_BR_ADMINISTRATOR', 'MEDIUM', 'Business-user maintenance; full auth administration stays in GUI.'],
  // --- HR (on-prem HCM sidecar - typically no S/4 Fiori path) ---
  ['PA20', '', 'No S/4 Fiori equivalent (HCM display)', 'NO_EQUIVALENT', 0, 'HR Administrator', 'PA', '', 'MEDIUM', 'HCM master data on-prem is out of the S/4 Fiori scope; SuccessFactors is the strategic path.'],
  ['PA30', '', 'No S/4 Fiori equivalent (HCM maintain)', 'NO_EQUIVALENT', 0, 'HR Administrator', 'PA', '', 'MEDIUM', 'As PA20.']
];

function toRow(entry) {
  const [tcode, fioriId, title, mappingType, coverage, persona, lob, role, editorial, rationale] = entry;
  return {
    MappingKey: `${tcode}::${fioriId || 'NONE'}`,
    Revision: REVISION,
    Origin: 'SHIPPED',
    TransactionCode: tcode,
    FioriId: fioriId,
    AppTitle: title,
    MappingType: mappingType,
    CoveragePercent: coverage,
    Persona: persona,
    LineOfBusiness: lob,
    RequiredBusinessRole: role,
    MinS4Release: '2023',
    ValueRationale: rationale,
    SourceReference: 'SAP Fiori Apps Reference Library (verify app ID per release)',
    EditorialConfidence: editorial,
    Active: true,
    Suppressed: false,
    TenantId: 'GLOBAL'
  };
}

// Idempotent boot upsert: insert new keys, upgrade rows whose shipped
// Revision moved on, never touch CUSTOMER rows.
async function seedShippedOverlay() {
  try {
    const existing = await SELECT.from('adops.db.AppMappingOverlay')
      .columns('ID', 'MappingKey', 'Revision')
      .where({ Origin: 'SHIPPED' });
    const existingByKey = new Map(existing.map((row) => [row.MappingKey, row]));

    let inserted = 0;
    let upgraded = 0;
    for (const entry of SHIPPED_MAPPINGS) {
      const row = toRow(entry);
      const hit = existingByKey.get(row.MappingKey);
      if (!hit) {
        await INSERT.into('adops.db.AppMappingOverlay').entries({ ID: randomUUID(), ...row });
        inserted += 1;
      } else if (Number(hit.Revision || 0) < REVISION) {
        await UPDATE('adops.db.AppMappingOverlay').set(row).where({ ID: hit.ID });
        upgraded += 1;
      }
    }
    if (inserted || upgraded) {
      LOG.info(`Shipped overlay: ${inserted} inserted, ${upgraded} upgraded (revision ${REVISION}, ${SHIPPED_MAPPINGS.length} mappings).`);
    }
  } catch (error) {
    // A seed failure must never block server startup (sap-backend.md).
    LOG.warn(`Shipped overlay seeding failed (continuing without): ${error.message}`);
  }
}

module.exports = { seedShippedOverlay, SHIPPED_MAPPINGS, REVISION };

CLASS zcl_ado_pseudonym DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    "---------------------------------------------------------------
    " Pseudonymises SAP user ids before they leave the system:
    " SHA-256 over salt + uppercased user, truncated to 24 hex chars.
    " Stable within one system+salt so the SaaS can aggregate per user
    " without ever holding the identity. Identified mode is an audited
    " opt-in enforced ABOVE this class - callers decide, this class
    " only hashes.
    "
    " Phase 2 moves the salt into ZADO_CFG (per-tenant); until then the
    " salt is system-derived so two systems never produce the same
    " pseudonym for the same user id.
    "---------------------------------------------------------------
    CLASS-METHODS hash
      IMPORTING iv_value       TYPE string
      RETURNING VALUE(rv_hash) TYPE string.
ENDCLASS.


CLASS zcl_ado_pseudonym IMPLEMENTATION.

  METHOD hash.
    DATA lv_hash TYPE string.
    TRY.
        cl_abap_message_digest=>calculate_hash_for_char(
          EXPORTING
            if_algorithm  = 'SHA-256'
            if_data       = |ZADO::{ sy-sysid }::{ to_upper( iv_value ) }|
          IMPORTING
            ef_hashstring = lv_hash ).
        rv_hash = to_lower( lv_hash(24) ).
      CATCH cx_abap_message_digest.
        " Never fall back to the clear value: an unusable pseudonym is
        " safer than a leaked identity.
        rv_hash = 'hash-unavailable'.
    ENDTRY.
  ENDMETHOD.

ENDCLASS.

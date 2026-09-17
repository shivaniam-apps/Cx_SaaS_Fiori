REPORT zado_cfg_init.

"---------------------------------------------------------------------
" AdoptOps add-on configuration: pseudonymisation secret.
"
" Run once per client (in particular in the PRODUCTIVE client the SaaS
" reads usage from). Creates the PSEUDONYM_SECRET row in ZADO_CFG when
" it is missing. ZADO_CFG is application data and is not transported,
" so every client keeps its own secret and no secret leaves the system.
"
" P_FORCE rotates an existing secret. Every pseudonym changes with it:
" usage snapshots taken before the rotation no longer join with later
" ones. Rotate only with the AdoptOps administrator's agreement.
"---------------------------------------------------------------------

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_force FOR FIELD p_force.
PARAMETERS p_force AS CHECKBOX.
SELECTION-SCREEN END OF LINE.

INITIALIZATION.
  c_force = 'Rotate existing secret'.

START-OF-SELECTION.
  DATA(lv_present) = xsdbool( zcl_ado_cfg=>pseudonym_secret( ) IS NOT INITIAL ).

  WRITE: / |System { sy-sysid } client { sy-mandt }|.

  IF lv_present = abap_true AND p_force IS INITIAL.
    WRITE: / 'Pseudonymisation secret is present - nothing changed.'.
    WRITE: / 'Tick "Rotate existing secret" to replace it (all pseudonyms change).'.
    RETURN.
  ENDIF.

  IF zcl_ado_cfg=>generate_pseudonym_secret( iv_force = p_force ) = abap_true.
    COMMIT WORK.
    IF lv_present = abap_true.
      WRITE: / 'Pseudonymisation secret ROTATED. Earlier usage snapshots no longer join with new ones.'.
    ELSE.
      WRITE: / 'Pseudonymisation secret generated and stored in ZADO_CFG.'.
    ENDIF.
    WRITE: / 'The secret is never displayed, exported or transported.'.
  ELSE.
    WRITE: / 'Secret could not be generated (UUID service unavailable). Nothing changed.'.
  ENDIF.

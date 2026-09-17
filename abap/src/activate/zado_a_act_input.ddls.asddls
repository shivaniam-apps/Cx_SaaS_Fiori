@EndUserText.label: 'AdoptOps activation step - input'
define abstract entity ZADO_A_ACT_INPUT
{
  StepType      : abap.string(0);
  ObjectKeyJson : abap.string(0);
  // true = read-only state probe (simulation), no LUW
  Probe         : abap_boolean;
}

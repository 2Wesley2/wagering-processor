/**
 * Perfil de conformidade do MiniStack (D48). Classes:
 * [P] pré-requisito: a correção da app depende disto; falha bloqueia os dependentes.
 * [D] divergência documentada da AWS: o teste afirma o comportamento esperado do
 *     emulador; se mudar, o teste falha e o ARCHITECTURE.md precisa ser revisto.
 * [N] negativo; [O] observacional (registra o observado, sem asserção de valor).
 * `dependents` lista os IDs que ficam BLOCKED se o caso falhar.
 */
export type ConfClass = 'P' | 'D' | 'N' | 'O';

export interface ConfCase {
  readonly id: string;
  readonly category: ConfClass;
  readonly title: string;
  readonly dependents: readonly string[];
  /** Para [D]: comportamento esperado do emulador, confirmado na 1ª execução. */
  readonly expected?: string;
}

export const CONF_CASES: readonly ConfCase[] = [
  { id: 'CONF-00', category: 'P', title: 'health e versão do emulador', dependents: ['*'] },
  { id: 'CONF-01', category: 'P', title: 'handshake do SDK v3 sob Bun (ListQueues)', dependents: ['*'] },
  { id: 'CONF-02', category: 'P', title: 'fila inexistente mapeia para QueueDoesNotExist', dependents: ['IT-29'] },
  { id: 'CONF-03', category: 'P', title: 'FIFO + DLQ FIFO com RedrivePolicy', dependents: ['IT-21', 'IT-22'] },
  { id: 'CONF-04', category: 'P', title: 'provisionamento repetível (unchanged/updated)', dependents: ['IT-01a'] },
  { id: 'CONF-05', category: 'P', title: 'ordem dentro do MessageGroup', dependents: ['IT-20'] },
  { id: 'CONF-06', category: 'P', title: 'bloqueio do grupo com mensagem em voo', dependents: ['IT-20', 'CT-01s'] },
  { id: 'CONF-07', category: 'P', title: 'deduplicação por MessageDeduplicationId', dependents: ['IT-25', 'IT-21b'] },
  { id: 'CONF-08', category: 'P', title: 'publishers concorrentes sem perda', dependents: ['IT-25', 'CT-06'] },
  {
    id: 'CONF-09',
    category: 'P',
    title: 'reentrega por expiração do VT com ReceiveCount',
    dependents: ['IT-23', 'CT-05'],
  },
  { id: 'CONF-10', category: 'P', title: 'ChangeMessageVisibility > 0 adia a reentrega', dependents: ['IT-22'] },
  { id: 'CONF-11', category: 'P', title: 'ChangeMessageVisibility(0) devolve na hora', dependents: ['IT-28'] },
  {
    id: 'CONF-12',
    category: 'D',
    title: 'DeleteMessage com receipt handle antigo',
    dependents: [],
    expected: 'error',
  },
  {
    id: 'CONF-13',
    category: 'P',
    title: 'RedrivePolicy move para a DLQ após maxReceiveCount',
    dependents: ['IT-22', 'IT-21e'],
  },
  { id: 'CONF-14', category: 'P', title: 'long poll respeita WaitTimeSeconds', dependents: ['IT-28'] },
  { id: 'CONF-15', category: 'P', title: '12 pollers concorrentes: entrega única', dependents: ['CT-04s'] },
  { id: 'CONF-16', category: 'O', title: 'contadores aproximados', dependents: [] },
  { id: 'CONF-17', category: 'P', title: 'atributos de mensagem e MD5 validados pelo SDK', dependents: ['IT-21'] },
  {
    id: 'CONF-18',
    category: 'P',
    title: 'long poll de cliente morto por SIGKILL termina em ≤ Wait',
    dependents: ['IT-28', 'CT-05'],
  },
  {
    id: 'CONF-19',
    category: 'N',
    title: 'VisibilityTimeout fora da faixa (> 43200) é rejeitado',
    dependents: [],
    // Calibrado na 1ª execução (run iisdoi0x): o MiniStack 1.5.40 valida a faixa, como a AWS.
    expected: 'rejected:InvalidAttributeValue',
  },
  {
    id: 'CONF-20',
    category: 'D',
    title: 'PurgeQueue imediato e repetível',
    dependents: ['IT-27b'],
    expected: 'immediate',
  },
  {
    id: 'CONF-21',
    category: 'D',
    title: 'MessageDeduplicationId > 128 caracteres não é rejeitado',
    dependents: ['UT-14'],
    expected: 'accepted',
  },
];

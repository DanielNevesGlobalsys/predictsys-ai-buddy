import jsPDF from 'jspdf';

interface TechnicalReportOptions {
  language?: 'pt' | 'en';
}

export function generateTechnicalReportPDF(options: TechnicalReportOptions = {}) {
  const { language = 'pt' } = options;
  const pdf = new jsPDF('p', 'mm', 'a4');
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 20;
  const contentWidth = pageWidth - 2 * margin;
  let yPos = margin;

  const colors = {
    primary: [59, 130, 246] as [number, number, number],    // Blue
    secondary: [100, 116, 139] as [number, number, number], // Slate
    success: [34, 197, 94] as [number, number, number],     // Green
    dark: [30, 41, 59] as [number, number, number],         // Slate-800
    light: [241, 245, 249] as [number, number, number],     // Slate-100
  };

  const checkPageBreak = (requiredSpace: number) => {
    if (yPos + requiredSpace > pageHeight - margin) {
      pdf.addPage();
      yPos = margin;
      return true;
    }
    return false;
  };

  const addHeader = () => {
    // Header background
    pdf.setFillColor(...colors.primary);
    pdf.rect(0, 0, pageWidth, 45, 'F');

    // Title
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(24);
    pdf.setFont('helvetica', 'bold');
    pdf.text('PredictSys AI', margin, 20);

    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'normal');
    pdf.text('Relatório Técnico de Arquitetura', margin, 30);

    // Version and date
    pdf.setFontSize(10);
    const dateStr = new Date().toLocaleDateString('pt-BR', { 
      day: '2-digit', 
      month: 'long', 
      year: 'numeric' 
    });
    pdf.text(`Versão 1.0 | ${dateStr}`, margin, 40);

    // Classification badge
    pdf.setFillColor(255, 255, 255);
    pdf.roundedRect(pageWidth - margin - 50, 15, 50, 20, 3, 3, 'F');
    pdf.setTextColor(...colors.primary);
    pdf.setFontSize(8);
    pdf.text('DOCUMENTO', pageWidth - margin - 45, 23);
    pdf.text('TÉCNICO-EXECUTIVO', pageWidth - margin - 48, 30);

    yPos = 55;
  };

  const addSectionTitle = (title: string, number: string) => {
    checkPageBreak(20);
    
    pdf.setFillColor(...colors.light);
    pdf.rect(margin, yPos, contentWidth, 12, 'F');
    
    pdf.setTextColor(...colors.primary);
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.text(`${number}. ${title}`, margin + 5, yPos + 8);
    
    yPos += 18;
  };

  const addSubsectionTitle = (title: string) => {
    checkPageBreak(15);
    
    pdf.setTextColor(...colors.dark);
    pdf.setFontSize(11);
    pdf.setFont('helvetica', 'bold');
    pdf.text(title, margin, yPos);
    
    yPos += 7;
  };

  const addParagraph = (text: string) => {
    checkPageBreak(15);
    
    pdf.setTextColor(...colors.secondary);
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'normal');
    
    const lines = pdf.splitTextToSize(text, contentWidth);
    pdf.text(lines, margin, yPos);
    yPos += lines.length * 5 + 3;
  };

  const addTable = (headers: string[], rows: string[][]) => {
    const colWidth = contentWidth / headers.length;
    const rowHeight = 8;
    
    checkPageBreak(rowHeight * (rows.length + 2));

    // Header row
    pdf.setFillColor(...colors.dark);
    pdf.rect(margin, yPos, contentWidth, rowHeight, 'F');
    
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'bold');
    headers.forEach((header, i) => {
      pdf.text(header, margin + i * colWidth + 3, yPos + 5.5);
    });
    yPos += rowHeight;

    // Data rows
    rows.forEach((row, rowIndex) => {
      if (rowIndex % 2 === 0) {
        pdf.setFillColor(...colors.light);
        pdf.rect(margin, yPos, contentWidth, rowHeight, 'F');
      }
      
      pdf.setTextColor(...colors.dark);
      pdf.setFontSize(9);
      pdf.setFont('helvetica', 'normal');
      row.forEach((cell, i) => {
        const truncated = cell.length > 35 ? cell.substring(0, 32) + '...' : cell;
        pdf.text(truncated, margin + i * colWidth + 3, yPos + 5.5);
      });
      yPos += rowHeight;
    });
    
    yPos += 5;
  };

  const addBulletList = (items: string[]) => {
    checkPageBreak(items.length * 6);
    
    pdf.setTextColor(...colors.dark);
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'normal');
    
    items.forEach(item => {
      pdf.setFillColor(...colors.primary);
      pdf.circle(margin + 2, yPos - 1, 1.5, 'F');
      
      const lines = pdf.splitTextToSize(item, contentWidth - 10);
      pdf.text(lines, margin + 8, yPos);
      yPos += lines.length * 5 + 2;
    });
    
    yPos += 3;
  };

  const addFooter = (pageNum: number, totalPages: number) => {
    const footerY = pageHeight - 10;
    
    pdf.setDrawColor(...colors.light);
    pdf.line(margin, footerY - 5, pageWidth - margin, footerY - 5);
    
    pdf.setTextColor(...colors.secondary);
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'normal');
    
    pdf.text('PredictSys AI - Documento Confidencial', margin, footerY);
    pdf.text(`Página ${pageNum} de ${totalPages}`, pageWidth - margin - 25, footerY);
  };

  // ==================== GENERATE CONTENT ====================

  addHeader();

  // Section 1: Architecture Overview
  addSectionTitle('Visão Geral da Arquitetura', '1');
  
  addSubsectionTitle('Tipo de Aplicação');
  addParagraph('Single Page Application (SPA) entregue como SaaS Multi-Tenant para uso empresarial (B2B).');
  
  addSubsectionTitle('Padrão Arquitetural');
  addBulletList([
    'Arquitetura Serverless com frontend desacoplado',
    'Event-Sourced Analytics para rastreabilidade completa',
    'Row-Level Security (RLS) para isolamento de dados por organização'
  ]);

  addSubsectionTitle('Fluxo Geral');
  addParagraph('Upload de Dataset → Análise Exploratória (EDA) → Treinamento AutoML → Predições em Batch → Dashboards de Negócio → Exportação e Decisões');

  // Section 2: Technology Stack
  addSectionTitle('Stack Tecnológico', '2');
  
  addSubsectionTitle('Frontend');
  addTable(
    ['Componente', 'Tecnologia', 'Versão'],
    [
      ['Linguagem', 'TypeScript', '^5.x'],
      ['Framework', 'React', '^18.3.1'],
      ['Build Tool', 'Vite', '^5.x'],
      ['Estilização', 'Tailwind CSS', '^3.x'],
      ['Componentes UI', 'shadcn/ui (Radix)', 'Latest'],
      ['Estado', 'TanStack Query', '^5.83.0'],
      ['Roteamento', 'React Router', '^6.30.1'],
      ['Gráficos', 'Recharts', '^2.15.4'],
    ]
  );

  addSubsectionTitle('Backend');
  addTable(
    ['Componente', 'Tecnologia', 'Detalhe'],
    [
      ['Runtime', 'Deno', 'Edge Functions'],
      ['Execução', 'Serverless (Edge)', 'Auto-scaling'],
      ['Linguagem', 'TypeScript', 'ESM Modules'],
      ['Banco de Dados', 'PostgreSQL 15+', 'Via Supabase'],
      ['Autenticação', 'Supabase Auth', 'JWT-based'],
      ['Storage', 'Supabase Storage', 'Object Storage'],
    ]
  );

  // Section 3: Data Layer
  addSectionTitle('Camada de Dados', '3');
  
  addSubsectionTitle('Banco de Dados');
  addTable(
    ['Aspecto', 'Especificação'],
    [
      ['Engine', 'PostgreSQL 15+'],
      ['Hospedagem', 'Supabase (Managed)'],
      ['Tipo', 'Relacional com JSONB'],
      ['Segurança', 'Row-Level Security (RLS) nativo'],
    ]
  );

  addSubsectionTitle('Storage de Arquivos');
  addTable(
    ['Bucket', 'Propósito', 'Acesso'],
    [
      ['datasets', 'Arquivos CSV (até 10GB)', 'Privado/Org'],
      ['exports', 'Exportações geradas', 'Privado/User'],
      ['big_imports', 'Importações batch', 'Privado'],
    ]
  );

  addSubsectionTitle('Estratégia Multi-Tenant');
  addParagraph('Isolamento completo por organization_id em todas as tabelas, usando RLS policies com funções security definer para evitar recursão. Funções: is_super_admin(), user_belongs_to_org(), has_role().');

  // Section 4: ML Engine
  addSectionTitle('Motor de Machine Learning', '4');
  
  addSubsectionTitle('Processamento por Etapa');
  addTable(
    ['Etapa', 'Execução', 'Edge Function'],
    [
      ['EDA', 'Serverless', 'calculate-eda'],
      ['Treinamento', 'Serverless', 'train-models'],
      ['Inferência Batch', 'Serverless', 'run-batch-predictions'],
      ['Inferência API', 'Serverless', 'predict'],
    ]
  );

  addSubsectionTitle('Algoritmos Implementados');
  addBulletList([
    'Classificação: Regressão Logística Regularizada (L2), Gradient Boosting Classifier',
    'Regressão: Regressão Linear Regularizada (Ridge), Gradient Boosting Regressor',
    'AutoML: Seleção automática baseada em tamanho do dataset (< 3.000 linhas → GB, senão → Linear)'
  ]);

  addSubsectionTitle('Estratégia para Grandes Volumes');
  addTable(
    ['Técnica', 'Valor', 'Propósito'],
    [
      ['MIN_ROWS_FOR_TRAIN', '5.000', 'Mínimo para treino confiável'],
      ['TARGET_SAMPLE_SIZE', '30.000', 'Amostra alvo de treino'],
      ['MAX_ROWS_TO_READ', '90.000', 'Early stop streaming'],
      ['MEDIAN_SAMPLE_SIZE', '5.000', 'Reservoir sampling'],
      ['MAX_BYTES_TO_READ', '25MB', 'Limite EDA'],
    ]
  );

  addSubsectionTitle('Limitações Técnicas');
  addTable(
    ['Limitação', 'Valor', 'Motivo'],
    [
      ['Timeout', '~30 segundos', 'Limite Edge Functions'],
      ['Memória', '~512MB', 'Limite runtime Deno'],
      ['CPU', 'Single-threaded', 'Arquitetura serverless'],
      ['Gradient Boosting', '≤3.000 linhas', 'Evitar timeout'],
      ['Datasets', '≤10GB', 'Limite de storage'],
    ]
  );

  // Section 5: Security & LGPD
  addSectionTitle('Segurança, LGPD e Governança', '5');
  
  addSubsectionTitle('Autenticação e Autorização');
  addTable(
    ['Aspecto', 'Implementação'],
    [
      ['Método', 'Email/Senha via Supabase Auth'],
      ['Tokens', 'JWT com refresh automático'],
      ['RBAC', 'super_admin, org_admin, analyst, viewer'],
      ['Isolamento', 'RLS em todas as tabelas'],
    ]
  );

  addSubsectionTitle('Conformidade LGPD');
  addTable(
    ['Requisito', 'Implementação'],
    [
      ['Retenção de Dados', 'Configurável por organização (meses)'],
      ['Retenção de Logs', 'Separada da retenção de dados'],
      ['Anonimização', 'Flag anonymize_ids na política'],
      ['Direito ao Esquecimento', 'Edge Function enforce-data-retention'],
      ['Auditoria', 'Tabela audit_logs com ações críticas'],
      ['Controle Exportação', 'Flag allow_data_export por org'],
    ]
  );

  addSubsectionTitle('Ações Auditadas');
  addBulletList([
    'dataset_uploaded, dataset_deleted',
    'model_trained, prediction_executed',
    'segment_exported, project_created, project_deleted',
    'retention_policy_updated, config_updated'
  ]);

  // Section 6: Scalability
  addSectionTitle('Escalabilidade e Custos', '6');
  
  addSubsectionTitle('Componentes que Escalam Linearmente');
  addBulletList([
    'Edge Functions: Auto-scaling ilimitado (pay-per-use)',
    'Storage: Até terabytes',
    'Conexões simultâneas: Gerenciado pelo Supabase',
    'Organizações: Sem limite técnico'
  ]);

  addSubsectionTitle('Pontos de Atenção');
  addTable(
    ['Componente', 'Limitação', 'Mitigação'],
    [
      ['Treinamento ML', '30s timeout, 512MB', 'Sampling + Early Stop'],
      ['EDA tempo real', 'Limite de bytes', 'Streaming + Reservoir'],
      ['Queries agregadas', 'Crescem com volume', 'Tabela pré-agregada'],
    ]
  );

  addSubsectionTitle('Adequação para SaaS Multi-Cliente');
  addBulletList([
    'Serverless: Zero gerenciamento de infraestrutura',
    'RLS nativo: Isolamento sem código adicional',
    'Pay-per-use: Custo proporcional ao uso real',
    'Edge Computing: Baixa latência global',
    'Managed PostgreSQL: Backups, updates, HA inclusos'
  ]);

  // Section 7: Executive Summary
  addSectionTitle('Resumo Executivo', '7');
  
  addSubsectionTitle('O Que é o PredictSys AI');
  addParagraph('Plataforma de inteligência artificial preditiva projetada para empresas que desejam transformar dados históricos em previsões acionáveis, sem necessidade de conhecimento técnico em ciência de dados.');

  addSubsectionTitle('Como Funciona');
  addBulletList([
    'Upload simples: O usuário carrega um arquivo CSV com dados históricos',
    'Análise automática: Identifica tipos de colunas e gera estatísticas',
    'Treinamento inteligente: Algoritmos ML treinados com um clique',
    'Previsões em escala: Modelo gera previsões para toda a base',
    'Decisões orientadas: Dashboards mostram impacto financeiro'
  ]);

  addSubsectionTitle('Por Que é Seguro');
  addBulletList([
    'Dados isolados por organização (RLS a nível de banco)',
    'Auditoria completa para conformidade LGPD',
    'Criptografia em trânsito (TLS) e repouso (AES-256)',
    'Controle granular de permissões por role'
  ]);

  addSubsectionTitle('Diferenciais');
  addTable(
    ['Aspecto', 'Vantagem'],
    [
      ['Sem código', 'Não requer programação'],
      ['Tempo rápido', 'Dados a previsões em minutos'],
      ['Chatbot IA', 'Explica resultados em linguagem de negócio'],
      ['Foco em ROI', 'Traduz predições em valor financeiro'],
      ['Compliance', 'LGPD pronto (retenção, auditoria)'],
    ]
  );

  // Add footers to all pages
  const totalPages = pdf.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    pdf.setPage(i);
    addFooter(i, totalPages);
  }

  // Generate filename with date
  const today = new Date().toISOString().split('T')[0];
  const filename = `PredictSys_AI_Relatorio_Tecnico_${today}.pdf`;
  
  pdf.save(filename);
  
  return filename;
}

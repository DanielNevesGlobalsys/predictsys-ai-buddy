-- Criar tabela de previsões genérica para todos os pipelines
CREATE TABLE public.predictions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  
  -- Identificador da entidade (cliente, contrato, pedido, etc.)
  entity_id TEXT NOT NULL,
  entity_type TEXT DEFAULT 'customer', -- 'customer', 'contract', 'order', 'product', etc.
  
  -- Datas de referência
  reference_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  prediction_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  horizon_days INTEGER DEFAULT 30,
  
  -- Tipo de problema (metadado)
  problem_type TEXT NOT NULL DEFAULT 'classification', -- 'classification', 'regression', 'time_series'
  problem_context TEXT, -- 'churn', 'propensao_compra', 'inadimplencia', 'demanda', 'ltv', etc.
  
  -- Para classificação
  probability_event DOUBLE PRECISION, -- 0-1
  predicted_class TEXT, -- 'yes', 'no', '0', '1', 'A', 'B', 'C', etc.
  
  -- Para regressão
  predicted_value DOUBLE PRECISION,
  
  -- Campos de segmentação (JSONB para flexibilidade)
  segment TEXT,
  age_group TEXT,
  region TEXT,
  state TEXT,
  city TEXT,
  product_category TEXT,
  channel TEXT,
  campaign TEXT,
  cohort TEXT,
  
  -- Campos de negócio opcionais
  potential_value DOUBLE PRECISION, -- valor potencial do cliente/transação
  average_ticket DOUBLE PRECISION,
  lifetime_value DOUBLE PRECISION,
  
  -- Metadados adicionais (para campos extras não mapeados)
  metadata JSONB DEFAULT '{}'::jsonb,
  
  -- Controle
  batch_id TEXT, -- identificador do lote de previsões
  is_latest BOOLEAN DEFAULT true, -- marca se é a previsão mais recente para a entidade
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Índices para performance
CREATE INDEX idx_predictions_project_id ON public.predictions(project_id);
CREATE INDEX idx_predictions_user_id ON public.predictions(user_id);
CREATE INDEX idx_predictions_entity_id ON public.predictions(entity_id);
CREATE INDEX idx_predictions_reference_date ON public.predictions(reference_date);
CREATE INDEX idx_predictions_problem_context ON public.predictions(problem_context);
CREATE INDEX idx_predictions_probability ON public.predictions(probability_event);
CREATE INDEX idx_predictions_is_latest ON public.predictions(is_latest);
CREATE INDEX idx_predictions_segment ON public.predictions(segment);
CREATE INDEX idx_predictions_region ON public.predictions(region);

-- Enable Row Level Security
ALTER TABLE public.predictions ENABLE ROW LEVEL SECURITY;

-- Create policies for user access
CREATE POLICY "Users can view their own predictions" 
ON public.predictions 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own predictions" 
ON public.predictions 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own predictions" 
ON public.predictions 
FOR UPDATE 
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own predictions" 
ON public.predictions 
FOR DELETE 
USING (auth.uid() = user_id);

-- Create trigger for automatic timestamp updates
CREATE TRIGGER update_predictions_updated_at
BEFORE UPDATE ON public.predictions
FOR EACH ROW
EXECUTE FUNCTION public.handle_updated_at();

-- Enable realtime for predictions table
ALTER PUBLICATION supabase_realtime ADD TABLE public.predictions;
-- Create table for chat messages
CREATE TABLE public.project_chat_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'assistant')),
  message_text TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for performance
CREATE INDEX idx_chat_messages_project ON public.project_chat_messages(project_id);
CREATE INDEX idx_chat_messages_created ON public.project_chat_messages(created_at);

-- Enable RLS
ALTER TABLE public.project_chat_messages ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Only project owners can access their chat messages
CREATE POLICY "Users can view chat messages of their own projects"
ON public.project_chat_messages
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM projects
    WHERE projects.id = project_chat_messages.project_id
    AND projects.user_id = auth.uid()
  )
);

CREATE POLICY "Users can insert chat messages for their own projects"
ON public.project_chat_messages
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM projects
    WHERE projects.id = project_chat_messages.project_id
    AND projects.user_id = auth.uid()
  )
  AND user_id = auth.uid()
);

CREATE POLICY "Users can delete chat messages of their own projects"
ON public.project_chat_messages
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM projects
    WHERE projects.id = project_chat_messages.project_id
    AND projects.user_id = auth.uid()
  )
);
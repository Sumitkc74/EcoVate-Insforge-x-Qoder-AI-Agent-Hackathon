/**
 * POST /api/verify
 * 
 * Verification Agent endpoint that checks DIY completion photos.
 * Awards impact points if verification passes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb, auth } from '@/lib/insforge';
import { verifyWithGroq } from '@/lib/groq-vision';
import { uploadImage } from '@/lib/storage';

export async function POST(request: NextRequest) {
  try {
    // Parse request body
    const formData = await request.formData();
    const bodyUserId = formData.get('userId') as string;
    
    // Verify authentication - accept userId from body
    let userId: string | null = bodyUserId || null;
    
    // Also try to verify with cookie as backup
    if (!userId) {
      const { data: userData } = await auth.getCurrentUser();
      if (userData?.user) {
        userId = userData.user.id;
      }
    }
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const imageFile = formData.get('image') as File;
    const scanId = formData.get('scanId') as string;
    const projectTitle = formData.get('projectTitle') as string;
    const packagingType = formData.get('packagingType') as string;
    const estimatedCo2Saved = parseFloat(formData.get('estimatedCo2Saved') as string) || 0.5;

    // Debug logging
    console.log('Verify request:', { 
      hasImage: !!imageFile, 
      scanId, 
      projectTitle, 
      packagingType,
      estimatedCo2Saved
    });

    // Check each field individually for better error messages
    const missingFields: string[] = [];
    if (!imageFile) missingFields.push('image');
    if (!scanId) missingFields.push('scanId');
    if (!projectTitle) missingFields.push('projectTitle');
    if (!packagingType) missingFields.push('packagingType');

    if (missingFields.length > 0) {
      return NextResponse.json({ 
        error: `Missing required fields: ${missingFields.join(', ')}`,
        received: { scanId, projectTitle, packagingType }
      }, { status: 400 });
    }

    // Convert image to base64 for AI processing
    const bytes = await imageFile.arrayBuffer();
    const base64Image = `data:${imageFile.type};base64,${Buffer.from(bytes).toString('base64')}`;

    // Try Gemini (free tier, server-side key) to verify the photo.
    // If Gemini is unavailable, the submission still succeeds as
    // pending below — it never errors on a verification AI failure.
    let verificationResult: { verified: boolean; confidence: number; feedback: string } | null = null;
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const mimeMatch = base64Image.match(/^data:([^;]+);base64,/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
        const rawBase64 = base64Image.replace(/^data:[^;]+;base64,/, '');
        const geminiResponse = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
            signal: AbortSignal.timeout(25000),
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: `You are evaluating a DIY upcycling project verification photo. Expected project: a DIY project made from a "${packagingType}", titled "${projectTitle}". Does this image show a completed DIY upcycling project using that packaging? Be fair but accurate. Respond ONLY with a JSON object: {"verified": true or false, "confidence": number between 0 and 1, "feedback": "brief explanation"}.` },
                  { inlineData: { mimeType, data: rawBase64 } },
                ],
              }],
            }),
          },
        );
        if (geminiResponse.ok) {
          const geminiJson = await geminiResponse.json();
          const content = geminiJson?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || '').join('') || '';
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            verificationResult = {
              verified: Boolean(parsed.verified),
              confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
              feedback: String(parsed.feedback || 'No feedback provided'),
            };
          }
        }
      } catch (err) {
        console.error('Gemini verification unavailable, falling back to pending:', err);
      }
    }
    // Second free attempt: Groq, before falling back to pending.
    if (!verificationResult) {
      verificationResult = await verifyWithGroq(base64Image, packagingType, projectTitle);
    }
    if (!verificationResult) {
      verificationResult = {
        verified: false,
        confidence: 0,
        feedback: 'Automatic verification is unavailable right now, so your project is saved as pending. You can check it in History.',
      };
    }

    // Upload verification image
    const { url: imageUrl, error: uploadError } = await uploadImage(
      imageFile, 
      `verifications/${userId}`
    );
    
    if (uploadError) {
      console.error('Image upload error:', uploadError);
    }

    // Determine verification status
    const isApproved = verificationResult.verified && verificationResult.confidence >= 0.85;
    const actionType = isApproved ? 'diy_completed' : 'diy_pending';
    
    // Calculate impact score (0 for pending)
    const impactScore = isApproved ? Math.round(10 + (estimatedCo2Saved * 20)) : 0;

    // Always save the verification attempt — and report the result
    // honestly. Previously a failed insert was only logged server-side
    // while the page still claimed "saved as pending", so a pending
    // project could silently never appear in History. (Known cause:
    // the imported user_actions CHECK constraint only allows
    // 'scanned', 'diy_selected' and 'diy_completed', so 'diy_pending'
    // inserts are rejected until the constraint is widened — see the
    // SQL note in the verify page. The page now shows this error
    // instead of claiming success.)
    let saved = true;
    let saveError: string | null = null;
    try {
      const { error: insertError } = await serverDb.from('user_actions').insert([{
        user_id: userId,
        scan_id: scanId,
        action_type: actionType,
        impact_score: impactScore,
        image_url: imageUrl,
      }]);
      if (insertError) {
        saved = false;
        saveError = insertError.message;
        console.error('Failed to save action:', insertError);
      }
    } catch (dbErr) {
      saved = false;
      saveError = (dbErr as Error).message;
      console.error('Failed to save action:', dbErr);
    }

    // If approved, update user's cumulative score
    if (isApproved && impactScore > 0) {
      try {
        const { data: userData } = await serverDb
          .from('users')
          .select('sustainability_score')
          .eq('id', userId)
          .single();

        if (userData) {
          await serverDb
            .from('users')
            .update({ 
              sustainability_score: (userData.sustainability_score || 0) + impactScore 
            })
            .eq('id', userId);
        }
      } catch (scoreErr) {
        console.error('Failed to update score:', scoreErr);
      }
    }

    return NextResponse.json({
      success: true,
      saved,
      saveError,
      verified: verificationResult.verified,
      confidence: verificationResult.confidence,
      feedback: verificationResult.feedback,
      impactScore,
      imageUrl,
    });

  } catch (error) {
    console.error('Verify API error:', error);
    return NextResponse.json({
      success: false,
      error: (error as Error).message,
    }, { status: 500 });
  }
}

export const maxDuration = 60;

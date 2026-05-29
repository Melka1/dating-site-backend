import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlogController } from './blog.controller';
import { BlogService } from './blog.service';
import { BlogComment } from './entities/blog-comment.entity';
import { BlogPostLike } from './entities/blog-post-like.entity';
import { BlogPostTag } from './entities/blog-post-tag.entity';
import { BlogPost } from './entities/blog-post.entity';
import { BlogTag } from './entities/blog-tag.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BlogPost,
      BlogPostTag,
      BlogTag,
      BlogPostLike,
      BlogComment,
    ]),
  ],
  controllers: [BlogController],
  providers: [BlogService],
  exports: [BlogService, TypeOrmModule],
})
export class BlogModule {}

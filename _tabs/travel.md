---
# Travel tab: lists every post whose `categories` includes "Travel".
# Served at /travel/ via the tabs permalink (/:title/) in _config.yml.
icon: fas fa-plane
order: 4
---

{% include lang.html %}

{% assign travel_posts = site.categories['Travel'] %}

<div id="page-category">
  {% if travel_posts and travel_posts.size > 0 %}
    <ul class="content ps-0">
      {% for post in travel_posts %}
        <li class="d-flex justify-content-between px-md-3">
          <a href="{{ post.url | relative_url }}">{{ post.title }}</a>
          <span class="dash flex-grow-1"></span>
          {% include datetime.html date=post.date class='text-muted small text-nowrap' lang=lang %}
        </li>
      {% endfor %}
    </ul>
  {% else %}
    <p class="text-muted">Travel stories are coming soon. 旅遊文章準備中。</p>
  {% endif %}
</div>
